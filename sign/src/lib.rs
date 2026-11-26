//! IPA signing for the browser: apple-codesign compiled with Emscripten.
//!
//! One call takes the IPA, the signing key and certificate and, per bundle, a
//! provisioning profile and bundle id, and returns the signed IPA. The bundle is
//! unpacked into Emscripten's in-memory file system and signed in place the way
//! xkit's `Signer::sign` does (same settings), then zipped again.
//!
//! C ABI (see ../web/signer.js):
//!   int32 ferry_sign(ipa, ipa_len, key_pem, key_len, cert_der, cert_len,
//!                    config_json, config_len, FerryBuf *out)
//!   int32 ferry_inspect(ipa, ipa_len, FerryBuf *out)   // JSON: bundles + entitlements
//!   size_t ferry_last_error(char *buf, size_t cap)
//!   void ferry_buf_free(FerryBuf *buf)

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use apple_codesign::cryptography::InMemoryPrivateKey;
use apple_codesign::{MachFile, SettingsScope, SigningSettings, UnifiedSigner};
use x509_certificate::CapturedX509Certificate;

type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    /// Per bundle, keyed by path relative to the .app ("" is the app itself).
    #[serde(default)]
    bundles: BTreeMap<String, BundleConfig>,
    /// Delete nested bundles (PlugIns/*.appex, Extensions/*) that have no entry.
    #[serde(default)]
    remove_unconfigured_extensions: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleConfig {
    /// New CFBundleIdentifier, if any.
    bundle_id: Option<String>,
    /// The embedded.mobileprovision to install, base64.
    profile: Option<String>,
    /// Entitlements plist (XML). Defaults to the profile's Entitlements.
    entitlements: Option<String>,
}

const WORK: &str = "/ferry-sign";

fn unzip(ipa: &[u8], into: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut archive = zip::ZipArchive::new(Cursor::new(ipa)).map_err(err)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(err)?;
        let Some(relative) = entry.enclosed_name() else {
            return Err(format!("unsafe path in the IPA: {}", entry.name()));
        };
        let path = into.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&path).map_err(err)?;
            continue;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(err)?;
        }
        let mode = entry.unix_mode();
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(err)?;
        if mode.is_some_and(|m| m & 0o170000 == 0o120000) {
            // Symlinks (macOS-style frameworks): keep them so signing sees the real layout.
            let target = String::from_utf8(bytes).map_err(err)?;
            std::os::unix::fs::symlink(target, &path).map_err(err)?;
        } else {
            fs::write(&path, bytes).map_err(err)?;
            if let Some(mode) = mode {
                let _ = fs::set_permissions(&path, fs::Permissions::from_mode(mode & 0o7777));
            }
        }
    }
    Ok(())
}

fn zip_dir(root: &Path) -> Result<Vec<u8>> {
    use std::os::unix::fs::PermissionsExt;
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let mut stack = vec![root.join("Payload")];
    let mut entries = Vec::new();
    while let Some(dir) = stack.pop() {
        entries.push(dir.clone());
        let mut children = fs::read_dir(&dir)
            .map_err(err)?
            .map(|e| e.map(|e| e.path()))
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(err)?;
        children.sort();
        for child in children.into_iter().rev() {
            if fs::symlink_metadata(&child).map_err(err)?.is_dir() {
                stack.push(child);
            } else {
                entries.push(child);
            }
        }
    }
    for path in entries {
        let name = path.strip_prefix(root).map_err(err)?.to_string_lossy().into_owned();
        let meta = fs::symlink_metadata(&path).map_err(err)?;
        if meta.is_dir() {
            let options = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            writer.add_directory(format!("{name}/"), options).map_err(err)?;
        } else if meta.file_type().is_symlink() {
            let target = fs::read_link(&path).map_err(err)?;
            writer
                .add_symlink(name, target.to_string_lossy(), zip::write::SimpleFileOptions::default())
                .map_err(err)?;
        } else {
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(meta.permissions().mode() & 0o7777);
            writer.start_file(name, options).map_err(err)?;
            writer.write_all(&fs::read(&path).map_err(err)?).map_err(err)?;
        }
    }
    Ok(writer.finish().map_err(err)?.into_inner())
}

fn find_app(root: &Path) -> Result<PathBuf> {
    fs::read_dir(root.join("Payload"))
        .map_err(|_| "not an .ipa: no Payload folder".to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .ok_or_else(|| "not an .ipa: no Payload/*.app".to_string())
}

/// The plist inside a CMS-signed mobileprovision (between `<?xml` and `</plist>`).
fn profile_plist(profile: &[u8]) -> Result<plist::Dictionary> {
    let find = |needle: &[u8]| profile.windows(needle.len()).position(|w| w == needle);
    let start = find(b"<?xml").ok_or("the profile has no plist")?;
    let end = find(b"</plist>").ok_or("the profile has no plist")? + b"</plist>".len();
    plist::from_bytes(&profile[start..end]).map_err(err)
}

/// Nested bundles as (the scope string apple-codesign uses, absolute path).
fn nested_bundles(app: &Path) -> Result<Vec<(String, PathBuf)>> {
    let bundle = apple_bundles::DirectoryBundle::new_from_path(app).map_err(err)?;
    Ok(bundle
        .nested_bundles(true)
        .map_err(err)?
        .into_iter()
        .map(|(scope, b)| (scope, b.root_dir().to_path_buf()))
        .collect())
}

fn is_extension(scope: &str) -> bool {
    scope.starts_with("PlugIns/") || scope.starts_with("Extensions/")
}

fn executable_entitlements(bundle: &Path) -> Option<plist::Dictionary> {
    let info: plist::Dictionary = plist::from_file(bundle.join("Info.plist")).ok()?;
    let exe = bundle.join(info.get("CFBundleExecutable")?.as_string()?);
    let data = fs::read(exe).ok()?;
    let file = MachFile::parse(&data).ok()?;
    let signature = file.nth_macho(0).ok()?.code_signature().ok()??;
    let slot = signature.entitlements().ok()??;
    plist::from_bytes(slot.to_string().as_bytes()).ok()
}

fn with_workdir<T>(ipa: &[u8], work: impl FnOnce(&Path, PathBuf) -> Result<T>) -> Result<T> {
    let root = Path::new(WORK);
    let _ = fs::remove_dir_all(root);
    fs::create_dir_all(root).map_err(err)?;
    let result = unzip(ipa, root).and_then(|()| find_app(root)).and_then(|app| work(root, app));
    let _ = fs::remove_dir_all(root);
    result
}

fn sign(ipa: &[u8], key_pem: &[u8], cert_der: &[u8], config: Config) -> Result<Vec<u8>> {
    with_workdir(ipa, |root, app| {
        let mut nested = nested_bundles(&app)?;
        if config.remove_unconfigured_extensions {
            for (scope, path) in &nested {
                if is_extension(scope) && !config.bundles.contains_key(scope) {
                    fs::remove_dir_all(path).map_err(err)?;
                }
            }
            nested = nested_bundles(&app)?;
        }

        let pem = pem::parse(key_pem).map_err(err)?;
        let key = match pem.tag() {
            "PRIVATE KEY" => InMemoryPrivateKey::from_pkcs8_der(pem.contents()).map_err(err)?,
            "RSA PRIVATE KEY" => InMemoryPrivateKey::from_pkcs1_der(pem.contents()).map_err(err)?,
            _ => return Err("expected a PEM private key".into()),
        };
        let cert = CapturedX509Certificate::from_der(cert_der.to_vec()).map_err(err)?;
        let mut settings = SigningSettings::default();
        settings.set_signing_key(&key, cert);
        settings.chain_apple_certificates();
        settings.set_team_id_from_signing_certificate();

        for (scope, bundle) in &config.bundles {
            let path = if scope.is_empty() {
                app.clone()
            } else {
                nested
                    .iter()
                    .find(|(s, _)| s == scope)
                    .map(|(_, p)| p.clone())
                    .ok_or_else(|| format!("no nested bundle {scope}"))?
            };
            if let Some(id) = &bundle.bundle_id {
                let info_path = path.join("Info.plist");
                let mut info: plist::Dictionary = plist::from_file(&info_path).map_err(err)?;
                info.insert("CFBundleIdentifier".into(), id.clone().into());
                plist::to_file_xml(&info_path, &info).map_err(err)?;
            }
            let mut entitlements = bundle.entitlements.clone();
            if let Some(profile) = &bundle.profile {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD.decode(profile).map_err(err)?;
                if entitlements.is_none()
                    && let Some(plist::Value::Dictionary(e)) = profile_plist(&bytes)?.get("Entitlements")
                {
                    let mut xml = Vec::new();
                    plist::to_writer_xml(&mut xml, e).map_err(err)?;
                    entitlements = Some(String::from_utf8(xml).map_err(err)?);
                }
                fs::write(path.join("embedded.mobileprovision"), bytes).map_err(err)?;
            }
            if let Some(xml) = entitlements {
                let scope = if scope.is_empty() { SettingsScope::Main } else { SettingsScope::Path(scope.clone()) };
                settings.set_entitlements_xml(scope, xml).map_err(err)?;
            }
        }

        UnifiedSigner::new(settings).sign_path_in_place(&app).map_err(err)?;
        zip_dir(root)
    })
}

/// What provisioning needs to know about an IPA: its bundles, ids and requested entitlements.
fn inspect(ipa: &[u8]) -> Result<String> {
    with_workdir(ipa, |_, app| {
        let mut bundles = vec![(String::new(), app.clone())];
        bundles.extend(nested_bundles(&app)?);
        let mut out = Vec::new();
        for (scope, path) in bundles {
            let info: plist::Dictionary = plist::from_file(path.join("Info.plist")).map_err(err)?;
            let s = |k: &str| info.get(k).and_then(|v| v.as_string()).map(str::to_owned);
            let entitlements: serde_json::Map<String, serde_json::Value> = executable_entitlements(&path)
                .unwrap_or_default()
                .into_iter()
                .map(|(k, v)| (k, serde_json::to_value(&v).unwrap_or(serde_json::Value::Null)))
                .collect();
            out.push(serde_json::json!({
                "path": scope,
                "bundleId": s("CFBundleIdentifier"),
                "name": s("CFBundleDisplayName").or(s("CFBundleName")),
                "version": s("CFBundleShortVersionString"),
                "extension": is_extension(&scope),
                "entitlements": entitlements,
            }));
        }
        serde_json::to_string(&out).map_err(err)
    })
}

// ---- C ABI ----

thread_local! {
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

#[repr(C)]
pub struct FerryBuf {
    pub ptr: *mut u8,
    pub len: usize,
}

unsafe fn slice<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 { &[] } else { unsafe { std::slice::from_raw_parts(ptr, len) } }
}

fn finish(result: Result<Vec<u8>>, out: *mut FerryBuf) -> i32 {
    match result {
        Ok(bytes) => {
            let bytes = Box::leak(bytes.into_boxed_slice());
            unsafe { *out = FerryBuf { ptr: bytes.as_mut_ptr(), len: bytes.len() } };
            0
        }
        Err(message) => {
            LAST_ERROR.with(|e| *e.borrow_mut() = message);
            -1
        }
    }
}

/// # Safety
/// Pointers must be valid for their lengths; `out` must point to a FerryBuf.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ferry_sign(
    ipa: *const u8,
    ipa_len: usize,
    key_pem: *const u8,
    key_len: usize,
    cert_der: *const u8,
    cert_len: usize,
    config_json: *const u8,
    config_len: usize,
    out: *mut FerryBuf,
) -> i32 {
    let result = serde_json::from_slice::<Config>(unsafe { slice(config_json, config_len) })
        .map_err(err)
        .and_then(|config| unsafe {
            sign(slice(ipa, ipa_len), slice(key_pem, key_len), slice(cert_der, cert_len), config)
        });
    finish(result, out)
}

/// # Safety
/// Pointers must be valid for their lengths; `out` must point to a FerryBuf.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ferry_inspect(ipa: *const u8, ipa_len: usize, out: *mut FerryBuf) -> i32 {
    finish(inspect(unsafe { slice(ipa, ipa_len) }).map(String::into_bytes), out)
}

/// # Safety
/// `buf` must have room for `cap` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ferry_last_error(buf: *mut u8, cap: usize) -> usize {
    LAST_ERROR.with(|e| {
        let e = e.borrow();
        if cap == 0 {
            return 0;
        }
        let n = e.len().min(cap - 1);
        unsafe {
            std::ptr::copy_nonoverlapping(e.as_ptr(), buf, n);
            *buf.add(n) = 0;
        }
        n
    })
}

/// # Safety
/// `buf` must come from ferry_sign / ferry_inspect.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ferry_buf_free(buf: *mut FerryBuf) {
    let buf = unsafe { &mut *buf };
    if !buf.ptr.is_null() {
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(buf.ptr, buf.len)) });
        buf.ptr = std::ptr::null_mut();
        buf.len = 0;
    }
}

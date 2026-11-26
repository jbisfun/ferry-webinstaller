import SwiftUI
import SwiftUIWebBrowserIO

struct DeviceSummary: Codable, Equatable {
  var udid: String
  var name: String
  var model: String
  var version: String
}

struct PackageSummary: Codable, Equatable {
  var file: String
  var name: String
  var bundleId: String
  var version: String
  var size: Int
}

struct InstallProgress: Codable {
  var stage: String
  var percent: Int
}

struct Team: Codable, Equatable {
  var teamId: String
  var name: String
}

struct AccountSummary: Codable, Equatable {
  var email: String?
  var name: String?
  var team: Team?
  var error: String?
}

/// isideload's TwoFactorCallbackParams.
struct TwoFactorRequest: Codable, Equatable {
  var lastError: String?
}

struct InstallResult: Codable {
  var signed: Bool?
  var special: String?
  var error: String?
}

struct SignInRequest: Codable {
  var email: String
  var password: String
  var revokeCertificates: Bool
}

struct TwoFactorAnswer: Codable {
  var code: String?
  var devices: Bool?
}

/// Drives the `device` page service (Resources/device-service.js), which runs the
/// ios-webusb driver next to the page.
@Observable
final class Installer {
  var device: DeviceSummary?
  var package: PackageSummary?
  var busy = ""
  var stage = ""
  var percent = 0.0
  var message = ""
  var failure = ""

  var account: AccountSummary?
  var twoFactor: TwoFactorRequest?
  var signingIn = false
  var accountFailure = ""
  var accountNotice = ""

  private let service = BrowserService("device")
  private var observation: BrowserIOOperation?
  private var twoFactorObservation: BrowserIOOperation?
  private var noticeObservation: BrowserIOOperation?

  func start() async {
    observation = service.observe("progress") { [self] json in
      guard let progress = try? JSONDecoder().decode(InstallProgress.self, from: Data(json.utf8)) else { return }
      stage = progress.stage
      percent = Double(progress.percent) / 100
    }
    twoFactorObservation = service.observe("twoFactor") { [self] json in
      twoFactor = try? JSONDecoder().decode(TwoFactorRequest.self, from: Data(json.utf8))
    }
    noticeObservation = service.observe("notice") { [self] text in
      accountNotice = text
    }
    await run("Looking for a device") {
      self.device = try await self.decode(DeviceSummary.self, self.service.call("restore"))
    }
  }

  func connect() async {
    await run("Unlock the device and tap Trust if asked") {
      guard let found = try await self.decode(DeviceSummary.self, self.service.call("connect")) else { return }
      self.device = found
    }
  }

  func disconnect() async {
    _ = try? await service.call("disconnect")
    device = nil
  }

  func pick() async {
    await run("Reading the IPA") {
      if let picked = try await self.decode(PackageSummary.self, self.service.call("pickIpa")) {
        self.package = picked
        self.message = ""
      }
    }
  }

  func install() async {
    guard let package else { return }
    stage = account == nil ? "upload" : "sign"
    percent = 0
    await run(account == nil ? "Installing \(package.name)" : "Signing and installing \(package.name)") {
      let result = try await self.decode(InstallResult.self, self.service.call("install"))
      if let error = result?.error {
        self.failure = error
        return
      }
      self.message = result?.signed == true
        ? "\(package.name) signed with \(self.account?.email ?? "your Apple ID") and installed."
        : "\(package.name) installed."
    }
    stage = ""
  }

  func signIn(email: String, password: String, revokeCertificates: Bool) async {
    signingIn = true
    accountFailure = ""
    accountNotice = ""
    do {
      let request = SignInRequest(email: email, password: password, revokeCertificates: revokeCertificates)
      let payload = String(decoding: try JSONEncoder().encode(request), as: UTF8.self)
      let result = try await decode(AccountSummary.self, service.call("signIn", payload))
      if let error = result?.error {
        accountFailure = error
      } else {
        account = result
      }
    } catch {
      accountFailure = "Sign-in failed. See the browser console."
    }
    twoFactor = nil
    signingIn = false
  }

  /// An empty answer cancels the sign-in.
  func answerTwoFactor(_ answer: TwoFactorAnswer) async {
    twoFactor = nil
    let payload = (try? JSONEncoder().encode(answer)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    _ = try? await service.call("twoFactor", payload)
  }

  func signOut() async {
    _ = try? await service.call("signOut")
    account = nil
  }

  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T? {
    json.isEmpty ? nil : try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  private func run(_ label: String, _ work: @escaping () async throws -> Void) async {
    busy = label
    failure = ""
    do { try await work() } catch let error as BrowserIOError {
      failure = "The driver reported an error (\(error.code)). See the browser console."
    } catch {
      failure = "\(error)"
    }
    busy = ""
  }
}

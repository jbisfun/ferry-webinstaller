import SwiftUI

struct ContentView: View {
  @State private var installer = Installer()
  @State private var email = ""
  @State private var password = ""
  @State private var revokeCertificates = false
  @State private var code = ""

  var body: some View {
    NavigationStack {
      Form {
        accountSection
        deviceSection
        if installer.device != nil {
          packageSection
          appsSection
        }
        if !installer.busy.isEmpty {
          Section { ProgressView(installer.busy) }
        }
        if !installer.failure.isEmpty {
          Section { Text(installer.failure).foregroundStyle(.red) }
        }
      }
      .navigationTitle("Ferry")
    }
    .task { await installer.start() }
  }

  private var deviceSection: some View {
    Section("Device") {
      if let device = installer.device {
        LabeledContent("Name", value: device.name)
        LabeledContent("Model", value: device.model)
        LabeledContent("iOS", value: device.version)
        LabeledContent("UDID", value: device.udid)
        Button("Disconnect", role: .destructive) { Task { await installer.disconnect() } }
      } else {
        Text("Connect an iPhone or iPad with a cable. The browser talks to it over WebUSB; nothing is installed on this computer.")
          .foregroundStyle(.secondary)
        Button("Connect Device") { Task { await installer.connect() } }
          .buttonStyle(.borderedProminent)
          .disabled(!installer.busy.isEmpty)
      }
    }
  }

  private var accountSection: some View {
    Section {
      if let account = installer.account {
        LabeledContent("Apple ID", value: account.email ?? "")
        if let name = account.name, !name.isEmpty { LabeledContent("Name", value: name) }
        if let team = account.team { LabeledContent("Team", value: "\(team.name) (\(team.teamId))") }
        Button("Sign Out", role: .destructive) { Task { await installer.signOut() } }
      } else if let request = installer.twoFactor {
        if let error = request.lastError { Text(error).foregroundStyle(.red) }
        Text("Enter the verification code shown on your iPhone, iPad or Mac.")
        TextField("Code", text: $code)
        Button("Verify") {
          let entered = code
          code = ""
          Task { await installer.answerTwoFactor(TwoFactorAnswer(code: entered)) }
        }
        .buttonStyle(.borderedProminent)
        .disabled(code.count < 6)
        // Codes only go to trusted devices: Apple refuses SMS requests from GrandSlam clients.
        Button("Send a New Code") { Task { await installer.answerTwoFactor(TwoFactorAnswer(devices: true)) } }
        Button("Cancel", role: .destructive) { Task { await installer.answerTwoFactor(TwoFactorAnswer()) } }
      } else {
        TextField("Email", text: $email)
        SecureField("Password", text: $password)
        Toggle("Revoke an old certificate if the account has too many", isOn: $revokeCertificates)
        Button(installer.signingIn ? "Signing In..." : "Sign In") {
          let entered = password
          password = ""
          Task { await installer.signIn(email: email, password: entered, revokeCertificates: revokeCertificates) }
        }
        .buttonStyle(.borderedProminent)
        .disabled(installer.signingIn || email.isEmpty || password.isEmpty)
      }
      if !installer.accountFailure.isEmpty {
        Text(installer.accountFailure).foregroundStyle(.red)
      }
    } header: {
      Text("Apple ID")
    } footer: {
      Text("Optional. With an Apple ID, apps are signed in this browser and work for 7 days (free accounts). Your password goes only to Apple: TLS runs in the page, and the relay forwards encrypted bytes.")
    }
  }

  private var packageSection: some View {
    Section {
      if let package = installer.package {
        LabeledContent("App", value: package.name)
        LabeledContent("Bundle ID", value: package.bundleId)
        LabeledContent("Version", value: package.version)
        LabeledContent("Size", value: "\(package.size / 1_048_576) MB")
      }
      Button(installer.package == nil ? "Choose IPA..." : "Choose Another IPA...") {
        Task { await installer.pick() }
      }
      .disabled(!installer.busy.isEmpty)
      if installer.package != nil {
        Button(installer.account == nil ? "Install" : "Sign and Install") { Task { await installer.install() } }
          .buttonStyle(.borderedProminent)
          .disabled(!installer.busy.isEmpty)
      }
      if !installer.stage.isEmpty {
        ProgressView(installer.stage == "sign" ? "Signing" : installer.stage == "upload" ? "Uploading" : "Installing", value: installer.percent)
      }
      if !installer.message.isEmpty {
        Text(installer.message).foregroundStyle(.green)
      }
    } header: {
      Text("Install")
    } footer: {
      Text(installer.account == nil
        ? "Without an Apple ID the IPA must already be signed for this device."
        : "Registers this device and App IDs with your team, signs the IPA here and installs it.")
    }
  }

  private var appsSection: some View {
    Section("Installed Apps") {
      if installer.apps.isEmpty {
        Text("No user apps.").foregroundStyle(.secondary)
      }
      ForEach(installer.apps) { app in
        LabeledContent(app.name, value: app.version)
      }
    }
  }
}

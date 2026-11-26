import SwiftUI

struct ContentView: View {
  @State private var installer = Installer()

  var body: some View {
    NavigationStack {
      Form {
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
        Button("Install") { Task { await installer.install() } }
          .buttonStyle(.borderedProminent)
          .disabled(!installer.busy.isEmpty)
      }
      if !installer.stage.isEmpty {
        ProgressView(installer.stage == "upload" ? "Uploading" : "Installing", value: installer.percent)
      }
      if !installer.message.isEmpty {
        Text(installer.message).foregroundStyle(.green)
      }
    } header: {
      Text("Install")
    } footer: {
      Text("The IPA must already be signed for this device (for example with ferry).")
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

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

struct InstalledApp: Codable, Equatable, Identifiable {
  var bundleId: String
  var name: String
  var version: String
  var id: String { bundleId }
}

struct InstallProgress: Codable {
  var stage: String
  var percent: Int
}

/// Drives the `device` page service (Resources/device-service.js), which runs the
/// ios-webusb driver next to the page.
@Observable
final class Installer {
  var device: DeviceSummary?
  var package: PackageSummary?
  var apps: [InstalledApp] = []
  var busy = ""
  var stage = ""
  var percent = 0.0
  var message = ""
  var failure = ""

  private let service = BrowserService("device")
  private var observation: BrowserIOOperation?

  func start() async {
    observation = service.observe("progress") { [self] json in
      guard let progress = try? JSONDecoder().decode(InstallProgress.self, from: Data(json.utf8)) else { return }
      stage = progress.stage
      percent = Double(progress.percent) / 100
    }
    await run("Looking for a device") {
      self.device = try await self.decode(DeviceSummary.self, self.service.call("restore"))
      if self.device != nil { try await self.refreshApps() }
    }
  }

  func connect() async {
    await run("Unlock the device and tap Trust if asked") {
      guard let found = try await self.decode(DeviceSummary.self, self.service.call("connect")) else { return }
      self.device = found
      try await self.refreshApps()
    }
  }

  func disconnect() async {
    _ = try? await service.call("disconnect")
    device = nil
    apps = []
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
    stage = "upload"
    percent = 0
    await run("Installing \(package.name)") {
      _ = try await self.service.call("install")
      self.message = "\(package.name) installed."
      try await self.refreshApps()
    }
    stage = ""
  }

  func refreshApps() async throws {
    apps = try await decode([InstalledApp].self, service.call("apps")) ?? []
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

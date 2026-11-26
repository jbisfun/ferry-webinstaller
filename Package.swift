// swift-tools-version: 6.4
import PackageDescription

let package = Package(
  name: "FerryWebInstaller",
  dependencies: [
    .package(url: "https://github.com/Vitorsilveira31/SwiftUIWeb.git", from: "0.1.46")
  ],
  targets: [
    .executableTarget(
      name: "FerryWebInstaller",
      dependencies: [
        .product(name: "SwiftUIWeb", package: "swiftuiweb"),
        .product(name: "SwiftUIWebBrowser", package: "swiftuiweb"),
        .product(name: "SwiftUIWebBrowserIO", package: "swiftuiweb"),
      ],
      // `import SwiftUI` compiles against SwiftUIWeb, so the views read as on iOS.
      swiftSettings: [
        .unsafeFlags(["-module-alias", "SwiftUI=SwiftUIWeb"]),
        .swiftLanguageMode(.v5),
      ]
    )
  ]
)

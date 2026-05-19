const fs = require("fs");
const path = require("path");
const { withDangerousMod } = require("expo/config-plugins");

const CAMERA_SCANNER_POD =
  "  pod 'ExpoCameraBarcodeScanning', :path => '../node_modules/expo-camera/ios'";
const ZXING_POD = "  pod 'ZXingObjC', :modular_headers => true";

function insertPodAfterUseExpoModules(contents, podLine) {
  if (contents.includes(podLine.trim())) {
    return contents;
  }

  return contents.replace(
    /(^\s*use_expo_modules!\s*$)/m,
    `$1\n${podLine}`,
  );
}

module.exports = function withCameraBarcodeScanning(config) {
  return withDangerousMod(config, [
    "ios",
    (nextConfig) => {
      const podfile = path.join(
        nextConfig.modRequest.platformProjectRoot,
        "Podfile",
      );
      let contents = fs.readFileSync(podfile, "utf8");

      contents = insertPodAfterUseExpoModules(contents, CAMERA_SCANNER_POD);
      contents = insertPodAfterUseExpoModules(contents, ZXING_POD);

      fs.writeFileSync(podfile, contents);
      return nextConfig;
    },
  ]);
};

// Ad-hoc sign the packed .app before it goes into the .dmg.
//
// Without an Apple Developer ID the app ships unsigned, and on Apple Silicon an
// unsigned (or broken-signature) bundle is reported as "damaged" with no way to
// open it. An ad-hoc signature turns that into the normal "unidentified
// developer" prompt, which the user can clear once in System Settings.
// Replace with a real Developer ID + notarization when the account exists.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  // A universal build packs x64 and arm64 into "<out>-x64-temp" / "<out>-arm64-temp"
  // first, then merges them. Signing those halves gives each a different
  // _CodeSignature/CodeResources and the merge refuses them, so sign only the
  // merged app (this hook runs once more on it, without the -temp suffix).
  if (/-temp$/.test(context.appOutDir)) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};

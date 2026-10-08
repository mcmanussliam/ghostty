import { errorMessage, loadConfiguration, loadManifest } from "./protocol.mjs";

try {
  const [command, path] = process.argv.slice(2);
  if (!path)
    throw new Error("Provide a plugin directory or configuration file");
  if (command === "validate") {
    const { manifest } = await loadManifest(path);
    console.log(
      `${manifest.id} ${manifest.version}: manifest and entry path valid`,
    );
  } else if (command === "check-config") {
    const plugins = await loadConfiguration(path);
    console.log(`${plugins.length} enabled plugin(s): configuration valid`);
  } else
    throw new Error(
      "Usage: node cli.mjs validate <absolute-plugin-directory> | check-config <config-file>",
    );
} catch (error) {
  console.error(errorMessage(error));
  process.exitCode = 1;
}

// Plain JavaScript on purpose: it has to run, and explain, on the old Node
// versions that cannot load Switchyard's TypeScript at all.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(
    `Switchyard needs Node 24 or newer (it runs TypeScript directly and uses node:sqlite); this is Node ${process.versions.node}.\n` +
      "With nvm: `nvm install 24 && nvm use` (the repo has an .nvmrc).",
  );
  process.exit(1);
}

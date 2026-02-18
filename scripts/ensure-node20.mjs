const major = Number(process.versions.node.split('.')[0]);
if (major !== 20) {
  console.error(`\n[voice-bridge] Node ${process.versions.node} detected.`);
  console.error('[voice-bridge] This project is pinned to Node 20.x for Vosk compatibility.');
  console.error('[voice-bridge] Switch Node version (nvm/asdf/volta) and run again.\n');
  process.exit(1);
}

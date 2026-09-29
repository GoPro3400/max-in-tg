import fs from 'node:fs';

// The version this code is released as: the one in package.json, which the
// release tag (v<version>) and the Docker image tag are checked against.
const readVersion = () => {
  try {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof version === 'string' && version ? version : 'unknown';
  } catch {
    return 'unknown';
  }
};

export const APP_VERSION = readVersion();

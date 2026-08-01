import fs from 'node:fs/promises';
import { config } from '../config.js';

await fs.rm(config.sqlitePath, { force: true });
console.log(`Removed ${config.sqlitePath}`);

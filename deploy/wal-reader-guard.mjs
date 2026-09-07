import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function assertWalReader({ walDirectory, readerVersionFile = '/app/wal-reader-version', requiredVersion = 2 }) {
  if (!Number.isSafeInteger(requiredVersion) || requiredVersion < 1) throw Error('WAL_MIN_READER_VERSION_INVALID');
  let supportedVersion = 1;
  try {
    const version = (await readFile(readerVersionFile, 'utf8')).trim();
    if (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version))) throw Error('WAL_IMAGE_READER_VERSION_INVALID');
    supportedVersion = Number(version);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let minimum = requiredVersion;
  try {
    const marker = JSON.parse(await readFile(resolve(walDirectory, 'wal-format.json'), 'utf8'));
    if (!Number.isSafeInteger(marker.version) || marker.version < 1 || !Number.isSafeInteger(marker.minimumReaderVersion) || marker.minimumReaderVersion < marker.version) throw Error('WAL_FORMAT_MARKER_INVALID');
    minimum = Math.max(minimum, marker.minimumReaderVersion);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (supportedVersion < minimum) throw Error(`WAL_READER_DOWNGRADE_REFUSED: image supports ${supportedVersion}, volume/deployment requires ${minimum}`);
  return { supportedVersion, minimumReaderVersion: minimum };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await assertWalReader({ walDirectory: process.env.WAL_DIR ?? '/var/lib/smpp-telemetry/wal', requiredVersion: Number(process.env.WAL_MIN_READER_VERSION ?? 2) });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

import {copyFile,chmod,mkdtemp,rename,rm,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';

// Validate a fresh inode before replacing a signed executable. Never overwrite
// the inode macOS may still have mapped for a previous launch.
export async function installExecutable(source,destination,verify) {
  const directory=await mkdtemp(join(dirname(destination),'.executable-'));
  const candidate=join(directory,'node');
  try {
    await copyFile(source,candidate);await chmod(candidate,0o700);
    const digest=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
    if(await digest(source)!==await digest(candidate))throw Error('Executable copy failed integrity verification.');
    await verify(candidate);
    await rename(candidate,destination);
  } finally { await rm(directory,{recursive:true,force:true}); }
}

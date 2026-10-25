import {test,expect} from 'vitest'
import {workspaceFileForThread} from './workspaceFileThread'
test('versioned file thread identifiers resolve without adopting legacy or malformed roots',()=>{
 const id='12345678-1234-4234-8234-123456789abc'
 for(const file of [id,`file-${id}`])expect(workspaceFileForThread(`workspace-file-thread-${file}`)).toBe(file)
 for(const root of [`file-thread-f_${'a'.repeat(24)}`,id,`workspace-file-thread-${id}/extra`,'workspace-file-thread-'+ '-'.repeat(36)])expect(workspaceFileForThread(root)).toBeNull()
})

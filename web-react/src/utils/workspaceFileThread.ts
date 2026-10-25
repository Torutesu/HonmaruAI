// Only server-created versioned-file roots identify a workspace file.
export function workspaceFileForThread(threadId:string):string|null{
 return /^workspace-file-thread-((?:file-)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.exec(threadId)?.[1]??null
}

import {documentKind} from './documentPreview'
// Only raster formats are placed in an image element. HTML/XML/SVG never
// become active documents; supported text is handled by escaped renderers.
export function workspaceFilePreviewKind(type:string,name:string){
 const mime=type.split(';')[0].trim().toLowerCase()
 return ['image/png','image/jpeg','image/gif','image/webp','image/avif'].includes(mime)?'image':documentKind(mime,name)
}

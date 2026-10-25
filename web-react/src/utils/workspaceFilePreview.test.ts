import {expect,test} from 'vitest'
import {workspaceFilePreviewKind} from './workspaceFilePreview'
test('only known raster types use image rendering; active markup cannot select it',()=>{
 expect(workspaceFilePreviewKind('IMAGE/PNG; charset=binary','a.png')).toBe('image')
 expect(workspaceFilePreviewKind('image/svg+xml','a.svg')).toBeNull()
 expect(workspaceFilePreviewKind('text/html','a.html')).toBe('text')
 expect(workspaceFilePreviewKind('application/octet-stream','a.png')).toBeNull()
 expect(workspaceFilePreviewKind('text/csv','a.csv')).toBe('csv')
})

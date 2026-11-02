import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import {readFileSync,readdirSync} from 'node:fs'
import type {Plugin} from 'vite'

// What every client shares (docs/architecture/discord-model-platform-plan.md §11).
const shared = (name: string) => fileURLToPath(new URL(`../packages/${name}/src`, import.meta.url))

// PDF fonts and character maps are served by this app, never a public CDN.
function pdfAssets():Plugin {
  const assets=new Map<string,Buffer>()
  assets.set('LICENSE',readFileSync(new URL('./node_modules/pdfjs-dist/LICENSE',import.meta.url)))
  for(const folder of ['cmaps','standard_fonts']){
    const base=new URL(`./node_modules/pdfjs-dist/${folder}/`,import.meta.url)
    for(const name of readdirSync(base))
      assets.set(`${folder}/${name}`,readFileSync(new URL(name,base)))
  }
  return {name:'pdf-preview-assets',
    configureServer(server){server.middlewares.use('/pdfjs/',(req,res,next)=>{
      const bytes=assets.get((req.url||'').split('?')[0].replace(/^\//,''))
      if(!bytes)return next()
      res.setHeader('Content-Type','application/octet-stream');res.end(bytes)
    })},
    generateBundle(){for(const [name,source] of assets)this.emitFile({type:'asset',fileName:`pdfjs/${name}`,source})},
  }
}

export default defineConfig({
  plugins: [react(),pdfAssets()],
  resolve: {
    alias: { '@honmaru/core': shared('core'), '@honmaru/protocol': shared('protocol') },
  },
  server: { port: 3000, fs: { allow: ['..'] } },
  build: {
    // The chunk warning is about a single-page app whose whole code is one
    // route; splitting it would add a request and save nothing.
    chunkSizeWarningLimit: 600,
    // The real-component focus fixture is built only for the local E2E run.
    ...(process.env.E2E_FIXTURES === '1' ? { rollupOptions: { input: {
      app: fileURLToPath(new URL('./index.html', import.meta.url)),
      rowMenuFocus: fileURLToPath(new URL('./e2e/row-menu-focus.html', import.meta.url)),
    } } } : {}),
  },
})

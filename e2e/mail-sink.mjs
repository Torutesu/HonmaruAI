// Stands in for Resend, and records what the Worker actually sent.
//
// The point of the end-to-end test is that nothing hands it a sign-in code:
// it reads the code out of the message that left the Worker, the same way a
// person reads it out of their inbox. So this has to be a real HTTP server
// speaking Resend's shape, not a stub inside the process under test.
import { createServer } from 'node:http'

const sent = []

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/sent') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(sent))
    return
  }
  if (req.method === 'POST' && req.url === '/emails') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try { sent.push(JSON.parse(body)) } catch { sent.push({ raw: body }) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: `sink-${sent.length}` }))
    })
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(9099, '127.0.0.1', () => console.log('mail sink on 9099'))

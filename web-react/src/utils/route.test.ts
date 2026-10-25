import { describe, it, expect } from 'vitest'
import { appSectionHash, APP_SECTIONS, consumeAppDraftHash, parseRoute, hashForWorkflow, hashForApp, hashForAppSource, hashForJoin, hashForCard, hashForScreen, hashForView, hashForMessage, hashForThread, pathToHash } from './route'

it('source-app links enter chat in the named workspace, without accepting malformed targets',()=>{
 expect(parseRoute(hashForAppSource('app_one','team:acme'))).toMatchObject({screen:null,mode:'classic',appSource:true,appId:'app_one',appOrg:'team:acme'})
 for(const hash of ['#/apps/%3Cbad%3E/team%3Aacme?source=1','#/apps/app_one/%3Cbad%3E?source=1','#/apps/app_one?source=1'])expect(parseRoute(hash).appSource).toBeUndefined()
 expect(parseRoute(hashForApp('app_one','team:acme',{}))).toMatchObject({screen:'apps',appConversation:{}})
})

// The URL says where you are, and what a link you were sent opens.
describe('parseRoute', () => {
  it('reads a card, a list, a screen and the root', () => {
    expect(parseRoute('#/feed/c%2F1')).toMatchObject({ mode: 'cards', cardId: 'c/1', join: null })
    expect(parseRoute('#/list')).toMatchObject({ mode: 'classic', cardId: null })
    expect(parseRoute('#/you')).toMatchObject({ screen: 'profile', mode: null })
    expect(parseRoute('')).toEqual({ screen: null, mode: null, cardId: null, join: null })
    expect(parseRoute(hashForCard('c/1')).cardId).toBe('c/1')
  })

  it('reads an invitation, and only something shaped like one', () => {
    const code = 'a3f9c0de'.repeat(4)
    expect(parseRoute(hashForJoin(code)).join).toBe(code)
    expect(parseRoute(`#/join/${code.toUpperCase()}`).join).toBe(code)
    expect(parseRoute('#/join/not-a-code').join).toBeNull()
    expect(parseRoute('#/join/').join).toBeNull()
    expect(parseRoute('#/join/<script>').join).toBeNull()
  })

  it('reads the automations and the playbook, both ways', () => {
    expect(parseRoute('#/automations')).toEqual({ screen: 'automations', mode: null, cardId: null, join: null })
    expect(parseRoute('#/playbook')).toEqual({ screen: 'playbook', mode: null, cardId: null, join: null })
    expect(hashForScreen('automations')).toBe('#/automations')
    expect(hashForScreen('playbook')).toBe('#/playbook')
    expect(parseRoute(hashForScreen('playbook')).screen).toBe('playbook')
    expect(parseRoute('#/agents').screen).toBe('agents')
    expect(hashForScreen('agents')).toBe('#/agents')
  })

  it('names no screen for a path that is not one', () => {
    expect(parseRoute('#/automation').screen).toBeNull()
    expect(parseRoute('#/constructor').screen).toBeNull()
    expect(parseRoute('#/toString').screen).toBeNull()
  })
})

it('a link to a message opens the list at it', () => {
  expect(parseRoute('#/m/msg_abc-123')).toMatchObject({ mode: 'classic', messageId: 'msg_abc-123' })
  expect(parseRoute('#/m/<script>').messageId).toBeNull()
})

it('a Jam link opens the list on the conversation and joins its call', () => {
  expect(parseRoute('#/jam/b:kitchen')).toMatchObject({ mode: 'classic', jamView: 'b:kitchen' })
  expect(parseRoute('#/jam/g%3A0123456789abcdef').jamView).toBe('g:0123456789abcdef')
  expect(parseRoute('#/jam/javascript:alert(1)').jamView).toBeNull()
})

it('a conversation link opens the list on it — an agent’s too', () => {
  expect(parseRoute(hashForView('ag:agent_1'))).toMatchObject({ mode: 'classic', openView: 'ag:agent_1' })
  expect(parseRoute('#/c/b:kitchen').openView).toBe('b:kitchen')
  expect(parseRoute('#/c/javascript:alert(1)').openView).toBeNull()
})

it('a message link carries its workspace, and is read back with it', () => {
  expect(hashForMessage('msg_1', 'personal:abc')).toBe('#/m/msg_1/personal%3Aabc')
  expect(parseRoute('#/m/msg_1/personal%3Aabc')).toMatchObject({ messageId: 'msg_1', messageOrg: 'personal:abc' })
  expect(parseRoute('#/m/msg_1')).toMatchObject({ messageId: 'msg_1', messageOrg: null })
  expect(parseRoute('#/m/msg_1/<script>').messageOrg).toBeNull()
})

it('a message link to a GitHub owner/repo workspace keeps its workspace', () => {
  const hash = hashForMessage('msg_1', 'acme/widgets')
  expect(hash).toBe('#/m/msg_1/acme%2Fwidgets')
  expect(parseRoute(hash)).toMatchObject({ messageId: 'msg_1', messageOrg: 'acme/widgets' })
  expect(parseRoute(hashForMessage('msg_1', 'team:acme'))).toMatchObject({ messageOrg: 'team:acme' })
  expect(parseRoute('#/m/msg_1/acme%2F%3Cscript%3E').messageOrg).toBeNull()
})

// A link from outside is a real path (packages/core/src/links.ts), the same
// one the phone apps open; here it becomes its hash.
describe('links from outside', () => {
  it('turns a conversation path into the hash, with its workspace', () => {
    const hash = pathToHash('/c/b%3Akitchen?org=team%3Aacme')
    expect(hash).toBe('#/c/b%3Akitchen?org=team%3Aacme')
    expect(parseRoute(hash!)).toMatchObject({ mode: 'classic', openView: 'b:kitchen', openOrg: 'team:acme' })
    expect(parseRoute(pathToHash('/c/b%3Akitchen')!)).toMatchObject({ openView: 'b:kitchen', openOrg: null })
  })

  it('turns an invitation path into the join hash', () => {
    const code = 'a3f9c0de'.repeat(4)
    expect(parseRoute(pathToHash(`/join/${code}`)!).join).toBe(code)
  })

  it('leaves every other path alone', () => {
    expect(pathToHash('/')).toBeNull()
    expect(pathToHash('/index.html')).toBeNull()
    expect(pathToHash('/c/javascript:alert(1)')).toBeNull()
    expect(pathToHash('/privacy.html')).toBeNull()
  })

  it('drops a workspace that is not an id', () => {
    expect(parseRoute('#/c/b%3Ax?org=%3Cx%3E').openOrg).toBeNull()
  })
})

describe('a card in another workspace', () => {
  it('carries its workspace, and only a real one', () => {
    expect(parseRoute('#/feed/c1/org-abc')).toMatchObject({ mode: 'cards', cardId: 'c1', cardOrg: 'org-abc' })
    expect(parseRoute('#/feed/c1/%3Cscript%3E').cardOrg).toBeUndefined()
    expect(hashForCard('c1', 'o1')).toBe('#/feed/c1/o1')
    expect(hashForCard('c1')).toBe('#/feed/c1')
    expect(parseRoute('#/feed/c1').cardOrg).toBeUndefined()
  })
})

describe('the harness screens', () => {
  it('each has an address of its own, and comes back from it', () => {
    for (const screen of ['harness', 'apps', 'workflows', 'approvals', 'skills', 'hxagents'] as const) {
      const hash = hashForScreen(screen)
      expect(parseRoute(hash).screen, screen).toBe(screen)
    }
    expect(hashForScreen('hxagents')).toBe('#/agent-team')
  })
})

 describe('app detail links', () => {
  it('preserves the app and workspace across reloads', () => {
    expect(parseRoute(hashForApp('app_123', 'personal:abc'))).toMatchObject({ screen: 'apps', appId: 'app_123', appOrg: 'personal:abc' })
    expect(parseRoute('#/apps').appId).toBeUndefined()
  })
  it('rejects malformed app identifiers', () => {
    for (const id of ['%3Cscript%3E', '%2Fother', '%zz']) expect(parseRoute('#/apps/' + id).appId).toBeNull()
  })
})

it('app notification links retain workspace and exact record conversation',()=>{
 const scope={tableId:'tbl_one',rowId:'row_two'};
 expect(parseRoute(hashForApp('app_one','team:acme',scope))).toMatchObject({appId:'app_one',appOrg:'team:acme',appConversation:scope});
 expect(parseRoute(hashForApp('app_one','team:acme',{})).appConversation).toEqual({});
 expect(parseRoute('#/apps/app_one/team%3Aacme?chat=1&row=row_two').appConversation).toBeUndefined();
 expect(parseRoute('#/apps/app_one/team%3Aacme?chat=1&table=%3Cbad%3E&row=row_two').appConversation).toBeUndefined();
});

it('thread links open the thread rather than treating its root as a room message',()=>{
 expect(parseRoute(hashForThread('msg_one','team:acme'))).toMatchObject({screen:null,mode:'classic',threadId:'msg_one',threadOrg:'team:acme'})
 expect(parseRoute(hashForThread('msg_one','team:acme')).messageId).toBeUndefined()
 for(const hash of ['#/t/%3Cbad%3E/team%3Aacme','#/t/msg_one/%ZZ','#/t/msg_one/team%3Aacme/extra'])expect(parseRoute(hash).threadId).toBeNull()
})

it('workflow detail URLs retain workspace scope and reject ambiguous or malformed targets',()=>{
 expect(parseRoute(hashForWorkflow('wf_1','team:acme'))).toMatchObject({screen:'workflows',workflowId:'wf_1',workflowOrg:'team:acme'})
 for(const hash of ['#/workflows/wf_1','#/workflows/wf_1/%3Cinvalid%3E','#/workflows/%3Cbad%3E/team%3Aacme','#/workflows/wf_1/team%3Aacme/extra','#/workflows/%zz/team%3Aacme'])expect(parseRoute(hash).workflowId).toBeNull()
})

it('source filter navigation retains data viewer and ignores unsupported section values',()=>{
 expect(parseRoute(hashForAppSource('app_one','team:acme','data'))).toMatchObject({appSource:true,appSourceSection:'data',appId:'app_one',appOrg:'team:acme'})
 expect(parseRoute(hashForAppSource('app_one','team:acme')+'&section=settings').appSourceSection).toBeUndefined()
})

it('missing-source fallback keeps the data viewer and app conversation',()=>{
 expect(parseRoute(hashForApp('app_one','team:acme',{},'data'))).toMatchObject({screen:'apps',appSection:'data',appConversation:{},appId:'app_one',appOrg:'team:acme'})
 expect(parseRoute(hashForApp('app_one','team:acme')+'?section=unknown').appSection).toBeUndefined()
})

it('adjustment drafts round trip as bounded text for source and fallback navigation',()=>{
 const draft='「顧客 & 案件」のグループ化を調整： # / ?'
 expect(parseRoute(hashForAppSource('app_one','team:acme','data',draft))).toMatchObject({appSource:true,appDraft:draft,appSourceSection:'data'})
 expect(parseRoute(hashForApp('app_one','team:acme',{},'data',draft))).toMatchObject({appDraft:draft,appConversation:{},appSection:'data'})
 expect(parseRoute(hashForAppSource('app_one','team:acme')+'&draft='+ 'x'.repeat(1001)).appDraft).toBeUndefined()
})

it('consumes only a matching fallback draft and retains the app and data section',()=>{
 const hash=hashForApp('app_one','team:acme',{},'data','Adjust groups:')
 const next=consumeAppDraftHash(hash,'app_one','team:acme','Adjust groups:')!
 expect(parseRoute(next)).toMatchObject({appId:'app_one',appSection:'data',appConversation:{}})
 expect(parseRoute(next).appDraft).toBeUndefined()
 for(const [id,org,draft] of [['other','team:acme','Adjust groups:'],['app_one','team:other','Adjust groups:'],['app_one','team:acme','Changed']])expect(consumeAppDraftHash(hash,id,org,draft)).toBeNull()
 expect(consumeAppDraftHash(hashForAppSource('app_one','team:acme','data','Adjust groups:'),'app_one','team:acme','Adjust groups:')).toBeNull()
})

it('app section links restore each screen and retain conversation context without replacing another route',()=>{
 for(const section of APP_SECTIONS){
  const current=hashForApp('app','team:acme',{tableId:'tasks',rowId:'row'},'data','Unsent request')
  const next=appSectionHash(current,'app','team:acme',section)!
  expect(parseRoute(next)).toMatchObject({appSection:section,appConversation:{tableId:'tasks',rowId:'row'},appDraft:'Unsent request'})
  expect(parseRoute(hashForApp('app','team:acme',undefined,section)).appSection).toBe(section)
 }
 for(const hash of ['#/list',hashForAppSource('app','team:acme','data'),hashForApp('other','team:acme'),hashForApp('app','team:other')])expect(appSectionHash(hash,'app','team:acme','settings')).toBeNull()
 expect(parseRoute('#/apps/app/team%3Aacme?section=unknown').appSection).toBeUndefined()
})

it('file links remain bound to a valid conversation route',()=>{
 const id='file-12345678-1234-4234-8234-123456789abc'
 expect(parseRoute(`#/c/b%3Adesign?org=team%3Aacme&file=${id}`)).toMatchObject({openView:'b:design',openOrg:'team:acme',fileId:id})
 expect(parseRoute(`#/c/invalid?file=${id}`).fileId).toBeUndefined()
 expect(parseRoute('#/c/b%3Adesign?file=../private').fileId).toBeUndefined()
})

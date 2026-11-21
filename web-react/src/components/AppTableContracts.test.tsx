import {afterEach,expect,it,vi} from 'vitest'
import {act,create,ReactTestInstance,ReactTestRenderer} from 'react-test-renderer'
import {AppTableContracts} from './AppTableContracts'

vi.mock('../utils/i18n',()=>({getLocale:()=> 'ja',useT:()=>(key:string)=>key}))
afterEach(()=>vi.restoreAllMocks())

const entity:any={key:'primary',table:{id:'table/one',name:'Tasks',columns:[],updatedAt:'schema-v1'}}
const contract={'openapi':'3.1.0','x-honmaru-table':{id:'table/one'}}
function button(tree:ReactTestInstance,label:string){return tree.findAllByType('button').find(item=>item.children.includes(label))!}

it('publishes once, lists and loads a pinned contract, then presents a hash-pinned SDK command',async()=>{
 const api:any={tables:vi.fn().mockResolvedValue({tables:[{...entity.table,updatedAt:'schema-v1'}]}),tableContract:vi.fn().mockResolvedValue(contract),tableContracts:vi.fn().mockResolvedValue({versions:[]}),publishTableContract:vi.fn().mockResolvedValue({contractVersion:'a'.repeat(64),created:true}),tableContractVersion:vi.fn().mockResolvedValue({contractVersion:'a'.repeat(64),createdAt:'2026-01-01T00:00:00Z',createdBy:'Mika',contract})}
 let renderer!:ReactTestRenderer;let tree!:ReactTestInstance
 await act(async()=>{renderer=create(<AppTableContracts api={api} entities={[entity]} canPublish/>);await Promise.resolve()});tree=renderer.root
 await act(async()=>{button(tree,'Publish immutable contract').props.onClick();await Promise.resolve();await Promise.resolve();await Promise.resolve()})
 expect(api.publishTableContract).toHaveBeenCalledWith('table/one','schema-v1')
 expect(api.tableContractVersion).toHaveBeenCalledWith('table/one','a'.repeat(64))
 expect(JSON.stringify(tree.findByProps({'aria-label':'OpenAPI contract JSON'}).children)).toContain('3.1.0')
 const command=tree.findAllByType('textarea').find(item=>item.props.readOnly)
 expect(command?.props.value).toContain('--contract-version '+'a'.repeat(64))
 expect(command?.props.value).toContain('--org-id "$HONMARU_ORG_ID"')
 act(()=>renderer.unmount())
})

it('keeps publishing unavailable to viewers and clears a failed pinned snapshot',async()=>{
 const api:any={tables:vi.fn().mockResolvedValue({tables:[{...entity.table,updatedAt:'schema-v1'}]}),tableContract:vi.fn().mockResolvedValue(contract),tableContracts:vi.fn().mockResolvedValue({versions:[{contractVersion:'b'.repeat(64),createdAt:'2026-01-01T00:00:00Z',createdBy:'Mika'}]}),tableContractVersion:vi.fn().mockRejectedValue(new Error('Snapshot unavailable'))}
 let renderer!:ReactTestRenderer;let tree!:ReactTestInstance
 await act(async()=>{renderer=create(<AppTableContracts api={api} entities={[entity]} canPublish={false}/>);await Promise.resolve()});tree=renderer.root
 expect(tree.findAllByType('button').some(item=>item.children.includes('Publish immutable contract'))).toBe(false)
 const select=tree.findByProps({'aria-label':'Contract version'})
 await act(async()=>{select.props.onChange({target:{value:'b'.repeat(64)}});await Promise.resolve()})
 expect(tree.findAllByProps({'aria-label':'OpenAPI contract JSON'})).toHaveLength(0)
 expect(tree.findAllByProps({role:'alert'}).some(item=>item.children.includes('Snapshot unavailable'))).toBe(true)
 act(()=>renderer.unmount())
})

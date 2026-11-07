import {describe,expect,it} from 'vitest'
import {agentProgressLabel} from './agentProgress'

describe('ACP activity labels',()=>{
  it('shows localized work summaries without requiring tool arguments',()=>{
    expect(agentProgressLabel({kind:'tool',title:'Run checks',status:'in_progress'},'Mika')).toEqual({key:'Using {tool}',values:{tool:'Run checks'}})
    expect(agentProgressLabel({kind:'tool',title:'Read files',status:'completed'},'Mika').key).toBe('Finished {tool}')
    expect(agentProgressLabel({kind:'tool',title:'Write files',status:'failed'},'Mika').key).toBe('Could not finish {tool}')
    expect(agentProgressLabel({kind:'plan',title:'Plan',steps:[]},'Mika').key).toBe('Working through a plan')
    expect(agentProgressLabel({kind:'thinking',title:'Thinking'},'Mika').key).toBe('Thinking…')
    expect(agentProgressLabel({kind:'reply',title:'Preparing a reply'},'Mika').key).toBe('Writing a reply…')
    expect(agentProgressLabel(undefined,'Mika')).toEqual({key:'{name} is writing…',values:{name:'Mika'}})
  })
})

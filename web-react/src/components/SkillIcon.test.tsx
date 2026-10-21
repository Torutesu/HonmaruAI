import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test } from 'vitest'
import { SkillIcon } from './SkillIcon'
import { Icon } from './Icon'
import type { Skill } from '../utils/harness'

test('skill icons use local metadata assets and safely fall back for unknown or hostile values',()=>{
 let tree!:ReturnType<typeof create>
 const skill={id:'a',name:'browser-use',body:'',description:'',createdBy:'u'} as Skill
 act(()=>{tree=create(<SkillIcon skill={skill}/>)})
 expect(tree.root.findByType(Icon).props.name).toBe('globe')
 act(()=>tree.update(<SkillIcon skill={{...skill,metadata:{icon:'palette'}}}/>))
 expect(tree.root.findByType(Icon).props.name).toBe('palette')
 for(const name of ['unknown','constructor','__proto__']) {
  act(()=>tree.update(<SkillIcon skill={{...skill,name,metadata:{icon:'https://example.com/track.svg'}}}/>))
  expect(tree.root.findByType(Icon).props.name).toBe('book')
  expect(tree.root.findAllByType('img')).toHaveLength(0)
 }
 act(()=>tree.unmount())
})

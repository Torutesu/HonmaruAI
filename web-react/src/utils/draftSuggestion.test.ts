import {expect,test} from 'vitest'
import {resolveDraftSuggestion} from './draftSuggestion'

test('seeds the composer when it has no existing draft',()=>{
 expect(resolveDraftSuggestion('','','Adjust my personal view:')).toEqual({draft:'Adjust my personal view:',suggestion:''})
})

test('preserves existing text and exposes a separate route suggestion',()=>{
 expect(resolveDraftSuggestion('Unsent reply','','Adjust only this personal view:')).toEqual({draft:'Unsent reply',suggestion:'Adjust only this personal view:'})
})

test('keeps distinct suggestions available if another arrives before the first is chosen',()=>{
 expect(resolveDraftSuggestion('Unsent reply','Filter this view:','Group this view:')).toEqual({draft:'Unsent reply',suggestion:'Filter this view:\n\nGroup this view:'})
})

/** Keep an existing reply in the composer while retaining new route text as a separate choice. */
export function resolveDraftSuggestion(currentDraft:string,storedSuggestion:string,incomingSuggestion:string):{draft:string;suggestion:string} {
 if(!currentDraft&&!storedSuggestion&&incomingSuggestion)return {draft:incomingSuggestion,suggestion:''}
 const suggestions:string[]=[]
 for(const value of [storedSuggestion,incomingSuggestion])if(value.trim()&&value!==currentDraft&&!suggestions.includes(value))suggestions.push(value)
 return {draft:currentDraft,suggestion:suggestions.join('\n\n')}
}

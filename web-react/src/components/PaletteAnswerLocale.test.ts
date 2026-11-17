import {afterEach,describe,expect,it,vi} from 'vitest'
import {changeLocale,loadLocale,t} from '../utils/i18n'

const expected:Record<string,Record<string,string>>={
 ja:{'Ask AI about these results':'検索結果についてAIに質問','No matching sources were found.':'一致する情報源が見つかりませんでした。','AI answer is unavailable. Your search results are still available.':'AIの回答を利用できません。検索結果は引き続き表示されます。','Could not get an AI answer. Try again.':'AIの回答を取得できませんでした。もう一度お試しください。','Sources':'情報源','Open source':'情報源を開く'},
 es:{'Ask AI about these results':'Preguntar a la IA sobre estos resultados','No matching sources were found.':'No se encontraron fuentes coincidentes.','AI answer is unavailable. Your search results are still available.':'La respuesta de IA no está disponible. Los resultados de búsqueda siguen disponibles.','Could not get an AI answer. Try again.':'No se pudo obtener una respuesta de IA. Inténtalo de nuevo.','Sources':'Fuentes','Open source':'Abrir fuente'},
 fr:{'Ask AI about these results':'Interroger l’IA sur ces résultats','No matching sources were found.':'Aucune source correspondante trouvée.','AI answer is unavailable. Your search results are still available.':'La réponse de l’IA est indisponible. Vos résultats de recherche restent accessibles.','Could not get an AI answer. Try again.':'Impossible d’obtenir une réponse de l’IA. Réessayez.','Sources':'Sources','Open source':'Ouvrir la source'},
 de:{'Ask AI about these results':'KI zu diesen Ergebnissen befragen','No matching sources were found.':'Keine passenden Quellen gefunden.','AI answer is unavailable. Your search results are still available.':'Die KI-Antwort ist nicht verfügbar. Deine Suchergebnisse bleiben erhalten.','Could not get an AI answer. Try again.':'KI-Antwort konnte nicht abgerufen werden. Versuche es erneut.','Sources':'Quellen','Open source':'Quelle öffnen'},
}

afterEach(()=>{changeLocale('en');vi.unstubAllGlobals()})

describe('Workspace Find answer labels',()=>{
 for(const [locale,translations] of Object.entries(expected))it(`translates the AI answer controls in ${locale}`,async()=>{
  const values=new Map<string,string>()
  vi.stubGlobal('localStorage',{getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key)})
  await loadLocale(locale)
  changeLocale(locale)
  for(const [key,value] of Object.entries(translations))expect(t(key),`${locale}: ${key}`).toBe(value)
 })
})

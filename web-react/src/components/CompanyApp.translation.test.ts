import {expect,test} from 'vitest'
import ja from '../utils/locales/ja'
import es from '../utils/locales/es'
import fr from '../utils/locales/fr'
import de from '../utils/locales/de'

const catalogs={ja,es,fr,de}
const keys=[
 'Cannot load proposal JSON as an array. Fix it before continuing.',
 'Operation added to the proposal. Review it before previewing.',
 'Example: Open, In progress, Done','Table to edit columns','Column to edit','Column change action',
 'Rename column','Convert data type','Delete empty column','Column name after rename','Type after change',
 'Column options after conversion','Column relation target table','Column relation cardinality',
 'Columns with values cannot be deleted. Data is checked again before confirmation.',
 'Add {action} to proposal','Relation source table','Relation name','Example: Customers','Add relation to proposal',
 '{count} rows changed','{count} values cannot be converted or columns are not empty. Showing the first 20.',
 'Target record for “{label}”','Choose a record',
]

test.each(Object.entries(catalogs))('schema editor and migration preview copy is translated in %s',(_locale,catalog)=>{
 for(const key of keys)expect(catalog[key],key).toBeTruthy()
 for(const key of keys)expect(catalog[key],key).not.toBe(key)
})

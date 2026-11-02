// Decimal-to-Number safety here means decimal display round-trip preservation;
// ordinary fractions such as 0.1 can still have binary arithmetic error.
const MAX_DECIMAL_INPUT=20000

function decimalValue(input:string):string|null {
 if(input.length>MAX_DECIMAL_INPUT)return null
 const match=/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(input)
 if(!match)return null
 const fraction=match[3]??match[4]??'',raw=((match[2]||'')+fraction).replace(/^0+/,'')
 if(!raw)return '0'
 const trailing=raw.match(/0+$/)?.[0].length||0,exponent=Number(match[5]||0)-fraction.length+trailing
 if(!Number.isSafeInteger(exponent))return null
 return `${match[1]==='-'?'-':''}${trailing?raw.slice(0,-trailing):raw}e${exponent}`
}

// Finite Number integer values have at most 309 decimal digits. Limit the
// exponent before constructing BigInts, and reject anything indeterminate.
function exactLargeInteger(decimal:string,value:number):boolean {
 const parts=/^(-?)([1-9]\d*)e(-?\d+)$/.exec(decimal)
 if(!parts||typeof BigInt!=='function')return false
 const exponent=Number(parts[3])
 if(!Number.isSafeInteger(exponent)||exponent<0||parts[2].length+exponent>309)return false
 try{return BigInt(`${parts[1]}${parts[2]}`)*BigInt(10)**BigInt(exponent)===BigInt(value)}catch{return false}
}

export function decimalMatchesNumber(input:string,value:number):boolean {
 if(!Number.isFinite(value))return false
 const decimal=decimalValue(input)
 return decimal!==null&&value===Number(input)&&decimal===decimalValue(String(value))&&(!Number.isInteger(value)||Number.isSafeInteger(value)||exactLargeInteger(decimal,value))
}

export function numberPreservesDecimal(input:string):boolean {
 if(input.length>MAX_DECIMAL_INPUT)return false
 return decimalMatchesNumber(input,Number(input))
}

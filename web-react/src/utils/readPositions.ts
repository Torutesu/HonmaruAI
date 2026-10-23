// Read timestamps can move backwards on purpose. The server's mutation
// revision, not the timestamp, orders snapshots and HTTP/socket responses.
export class ReadPositions {
  private positions = new Map<string, {at:string;version:number}>()
  accept(key:string, at:string, version?:number):boolean {
    if(!at || !Number.isFinite(Date.parse(at)))return false
    const previous=this.positions.get(key)
    if(version!==undefined&&(!Number.isSafeInteger(version)||version<0))return false
    const revision=version??0
    if(previous && (revision<previous.version || (revision>0&&revision===previous.version)))return false
    this.positions.set(key,{at,version:revision});return true
  }
  snapshot(reads:Record<string,string>,versions:Record<string,number>={}) {
    const accepted:Record<string,string>={}
    for(const [key,at] of Object.entries(reads))if(this.accept(key,at,versions[key]))accepted[key]=at
    return accepted
  }
}

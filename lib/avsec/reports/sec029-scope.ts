/** SEC029 must retain the assigned station key, including KUL's entity suffix. */
export function withSec029Scope<T extends {station:string;team:string}>(values:T,profile:{station:string;team:string}):T {
  return {...values,station:profile.station,team:profile.team};
}

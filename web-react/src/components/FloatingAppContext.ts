import { createContext, useContext } from 'react'
import type { AppSection } from '../utils/route'
export const FloatingAppContext = createContext<((appId:string, section:AppSection)=>void)|null>(null)
export const useFloatingApp = () => useContext(FloatingAppContext)

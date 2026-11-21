/**
 * ChatLab API 服务 Preload API (hierarchical data source model)
 */

import { ipcRenderer, type IpcRendererEvent } from 'electron'

export interface ApiServerConfig {
  enabled: boolean
  port: number
  token: string
  createdAt: number
}

export interface ApiServerStatus {
  running: boolean
  port: number | null
  startedAt: number | null
  error: string | null
}

export const apiServerApi = {
  // ==================== API 服务管理 ====================

  getConfig: (): Promise<ApiServerConfig> => {
    return ipcRenderer.invoke('api:getConfig')
  },

  getStatus: (): Promise<ApiServerStatus> => {
    return ipcRenderer.invoke('api:getStatus')
  },

  setEnabled: (enabled: boolean): Promise<ApiServerStatus> => {
    return ipcRenderer.invoke('api:setEnabled', enabled)
  },

  setPort: (port: number): Promise<ApiServerStatus> => {
    return ipcRenderer.invoke('api:setPort', port)
  },

  regenerateToken: (): Promise<ApiServerConfig> => {
    return ipcRenderer.invoke('api:regenerateToken')
  },

  onStartupError: (callback: (data: { error: string }) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: { error: string }) => callback(data)
    ipcRenderer.on('api:startupError', handler)
    return () => ipcRenderer.removeListener('api:startupError', handler)
  },

  onImportCompleted: (callback: (localSessionId?: string) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, localSessionId?: string) => callback(localSessionId)
    ipcRenderer.on('api:importCompleted', handler)
    return () => ipcRenderer.removeListener('api:importCompleted', handler)
  },
}

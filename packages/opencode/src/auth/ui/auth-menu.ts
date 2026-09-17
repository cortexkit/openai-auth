import { select } from './select'

export type AuthMenuAction =
  | 'add-account'
  | 'auth-current'
  | 'check-quotas'
  | 'auth-doctor'
  | 'apply-repairs'
  | 'delete-all'
  | 'cancel'

export const AUTH_MENU_ITEMS: ReadonlyArray<{
  label: string
  value: Exclude<AuthMenuAction, 'cancel'>
  color: 'cyan' | 'red'
}> = [
  { label: 'Add account', value: 'add-account', color: 'cyan' },
  { label: 'Auth current', value: 'auth-current', color: 'cyan' },
  { label: 'Check quotas', value: 'check-quotas', color: 'cyan' },
  { label: 'Auth doctor', value: 'auth-doctor', color: 'cyan' },
  { label: 'Apply repairs', value: 'apply-repairs', color: 'cyan' },
  { label: 'Delete all accounts', value: 'delete-all', color: 'red' },
]

export const AUTH_MENU_ACTIONS = AUTH_MENU_ITEMS.map((item) => item.label)

export async function showAuthMenu(): Promise<AuthMenuAction> {
  const action = await select<AuthMenuAction>(AUTH_MENU_ITEMS, {
    message: 'OpenAI accounts',
    subtitle: 'Select an account action',
    clearScreen: true,
  })
  return action ?? 'cancel'
}

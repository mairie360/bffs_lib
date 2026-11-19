/**
 * Role names as Core spells them vary ("Admin", "admin", "ROLE_RESPONSABLE", "Maire"...). A BFF deciding on a role it
 * read from the token (`sessionRole`) or from Core compares normalized names (MAIR-525).
 */

/** `role` without accents, case, spaces, `_` / `-` nor a `role` prefix: `ROLE_RESPONSABLE` -> `responsable`. */
export function roleKey(role: string): string {
  return role
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace(/^role/, '');
}

/** True when one of `roles` is one of `names`, compared with `roleKey`. */
export function hasRole(roles: readonly string[], ...names: readonly string[]): boolean {
  const accepted = new Set(names.map(roleKey));
  return roles.some((role) => accepted.has(roleKey(role)));
}

/** The roles Core seeds (`roles` table of the database), from the widest to the narrowest. */
export const CORE_ROLES = ['Admin', 'Maire', 'Responsable', 'User', 'Guest'] as const;

export type CoreRole = (typeof CORE_ROLES)[number];

/** Spellings of the Core roles seen in tokens, Core answers and older data, by `roleKey`. */
const CORE_ROLE_ALIASES: Readonly<Record<string, CoreRole>> = Object.freeze({
  admin: 'Admin',
  administrateur: 'Admin',
  administrator: 'Admin',
  maire: 'Maire',
  mayor: 'Maire',
  responsable: 'Responsable',
  manager: 'Responsable',
  user: 'User',
  utilisateur: 'User',
  employe: 'User',
  employee: 'User',
  guest: 'Guest',
  invite: 'Guest',
});

/**
 * The Core role a name stands for ("Administrateur", "ROLE_ADMIN" and " admin " are `Admin`), or `null` for a
 * custom role or a value that is not a string. The one rule every BFF uses to recognise a role.
 */
export function canonicalRole(role: unknown): CoreRole | null {
  if (typeof role !== 'string') return null;
  const key = roleKey(role);
  return Object.prototype.hasOwnProperty.call(CORE_ROLE_ALIASES, key) ? CORE_ROLE_ALIASES[key] : null;
}

/** The Core roles among `roles`, from the widest (`Admin`) to the narrowest (`Guest`), without duplicates. */
export function canonicalRoles(roles: readonly unknown[]): CoreRole[] {
  const found = new Set(roles.map(canonicalRole));
  return CORE_ROLES.filter((role) => found.has(role));
}

/** True for the administrator role under any of its spellings; a custom role is never an administrator. */
export function isAdminRole(role: unknown): boolean {
  return canonicalRole(role) === 'Admin';
}

/** True for Admin, Maire and Responsable under any of their spellings: the roles that manage others' work. */
export function isManagerRole(role: unknown): boolean {
  const core = canonicalRole(role);
  return core === 'Admin' || core === 'Maire' || core === 'Responsable';
}

/**
 * Roles that see every task of a project they can see (Admin, Maire and Responsable, with their aliases); any
 * other role only sees the tasks assigned to it. Same set as `isManagerRole`.
 */
export const PROJECT_TASK_MANAGER_ROLES: readonly string[] = Object.freeze(
  Object.keys(CORE_ROLE_ALIASES).filter((key) => isManagerRole(key)),
);

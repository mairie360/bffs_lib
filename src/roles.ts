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

/**
 * Roles that see every task of a project they can see (BFF_Project's Admin, Maire and Responsable, with their
 * aliases); any other role only sees the tasks assigned to it.
 */
export const PROJECT_TASK_MANAGER_ROLES: readonly string[] = Object.freeze([
  'admin', 'administrateur', 'administrator', 'maire', 'mayor', 'responsable', 'manager',
]);

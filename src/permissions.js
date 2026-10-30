import { config } from './config.js';

/** Who may use the bot: the owner always, plus users and roles granted with cgrant. */
export class Permissions {
  constructor(store) {
    this.store = store;
    this.store.data.users ??= [];
    this.store.data.roles ??= [];
  }

  get users() {
    return this.store.data.users;
  }

  get roles() {
    return this.store.data.roles;
  }

  isOwner(userId) {
    return userId === config.ownerId;
  }

  isApproved(member) {
    if (!member) return false;
    if (this.isOwner(member.id)) return true;
    if (this.users.includes(member.id)) return true;
    return member.roles?.cache?.some((role) => this.roles.includes(role.id)) ?? false;
  }

  /** @param {'users'|'roles'} kind */
  grant(kind, id) {
    const list = this.store.data[kind];
    if (list.includes(id)) return false;
    list.push(id);
    this.store.save();
    return true;
  }

  revoke(kind, id) {
    const list = this.store.data[kind];
    const i = list.indexOf(id);
    if (i === -1) return false;
    list.splice(i, 1);
    this.store.save();
    return true;
  }
}

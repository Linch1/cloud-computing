import { ulid } from "ulid";

export function newUserId() {
  return `usr_${ulid()}`;
}

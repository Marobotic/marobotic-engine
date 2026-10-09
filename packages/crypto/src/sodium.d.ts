// libsodium-wrappers-sumo has the same API as libsodium-wrappers (plus Argon2id and friends); its
// published types don't resolve under NodeNext, so point them at the base package's types.
declare module "libsodium-wrappers-sumo" {
  import sodium from "libsodium-wrappers";
  export default sodium;
}

const bcrypt = require("bcryptjs");

const BCRYPT_ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(String(plain), String(hash));
}

module.exports = {
  hashPassword,
  verifyPassword,
};

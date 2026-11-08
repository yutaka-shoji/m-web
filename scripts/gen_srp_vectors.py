"""Generate SRP test vectors for the XBee BLE unlock (stdlib only).

The client math below is transcribed verbatim from the reference M-Logger BLE client
(et0614/mlogger software/python/mlogger/factory_test.py: `_b`, `_h`, `_hi`, `SrpClient`),
which unlocked 100/100 production units in factory tests. The XBee side is played with the
firmware's salt/verifier (firmware/mlogger_main.X/xbee_controller.c, at$S / at$V..$Y).
Python's arbitrary-precision ints give an implementation independent of the TypeScript one.

Usage:
    python3 -I scripts/gen_srp_vectors.py > tests/fixtures/srp-vectors.json
"""
import hashlib
import json
import sys

SRP_USER = "apiservice"
BLE_PASSWORD = "ml_pass"
SRP_N = int(
    "EEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C"
    "9C256576D674DF7496EA81D3383B4813D692C6E0E0D5D8E250B98BE4"
    "8E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B29"
    "7BCF1885C529F566660E57EC68EDBC3C05726CC02FD4CBF4976EAA9A"
    "FD5138FE8376435B9FC61D2FC0EB06E3",
    16,
)
SRP_G = 2
SRP_N_LEN = 128
SALT = bytes.fromhex("28513497")
VERIFIER = int(
    "6567694B0CA9ADCED8D5B2B0015718D1E2637B86E3E178E029936A078926C2B0"
    "259F6833E1E1932E4485F48865FB6B76EC6E847A7272C77A8C27DD7DF94E44DC"
    "A99A6E3937FBB8D05BBB4E4A8C4CB221C14D15CD004139C77B6FE0C8AF2932D8"
    "6D4411D507FC52AFD5877D6E8529AEE7FB931F10944BC0D058FB246D0DE071DB",
    16,
)


# ---- reference client (transcribed) ---------------------------------------------------
def _b(n):
    return n.to_bytes(max(1, (n.bit_length() + 7) // 8), "big")


def _h(*parts):
    m = hashlib.sha256()
    for p in parts:
        m.update(p)
    return m.digest()


def _hi(*parts):
    return int.from_bytes(_h(*parts), "big")


class SrpClient:
    def __init__(self, user, password, urandom):
        self.user = user.encode()
        self.password = password.encode()
        while True:
            self.a_raw = urandom(32)
            self.a = int.from_bytes(self.a_raw, "big")
            self.A = pow(SRP_G, self.a, SRP_N)
            if self.A.bit_length() > (SRP_N_LEN - 1) * 8:
                break

    def a_bytes(self):
        return self.A.to_bytes(SRP_N_LEN, "big")

    def process_challenge(self, salt, b_bytes):
        B = int.from_bytes(b_bytes, "big")
        if B % SRP_N == 0:
            return None
        A_b, B_b = _b(self.A), _b(B)
        u = _hi(A_b, B_b)
        k = _hi(_b(SRP_N), _b(SRP_G))
        x = _hi(_b(int.from_bytes(salt, "big")), _h(self.user, b":", self.password))
        S = pow((B - k * pow(SRP_G, x, SRP_N)) % SRP_N, self.a + u * x, SRP_N)
        self.K = _h(_b(S))
        h_xor = bytes(i ^ j for i, j in zip(_h(_b(SRP_N)), _h(_b(SRP_G))))
        self.M1 = _h(h_xor, _h(self.user), salt, A_b, B_b, self.K)
        self.M2 = _h(A_b, self.M1, self.K)
        return self.M1


# ---- vector generation -------------------------------------------------------------------
def draws(seed):
    i = 0
    while True:
        yield hashlib.sha256(f"{seed}/{i}".encode()).digest()
        i += 1


def make_case(seed_a, b_int):
    gen = draws(seed_a)
    client = SrpClient(SRP_USER, BLE_PASSWORD, lambda n: next(gen)[:n])
    k = _hi(_b(SRP_N), _b(SRP_G))
    B = (k * VERIFIER + pow(SRP_G, b_int, SRP_N)) % SRP_N
    b_bytes = B.to_bytes(SRP_N_LEN, "big")
    m1 = client.process_challenge(SALT, b_bytes)
    u = _hi(_b(client.A), _b(B))
    S = pow(client.A * pow(VERIFIER, u, SRP_N), b_int, SRP_N)  # server side
    assert _h(_b(S)) == client.K, "client and server disagree on the session key"
    return {
        "a": client.a_raw.hex(),
        "A": client.a_bytes().hex(),
        "salt": SALT.hex(),
        "B": b_bytes.hex(),
        "M1": m1.hex(),
        "M2": client.M2.hex(),
        "K": client.K.hex(),
        "B_leading_zero": B.bit_length() <= (SRP_N_LEN - 1) * 8,
        "S_leading_zero": S.bit_length() <= (SRP_N_LEN - 1) * 8,
    }


def b_from(i):
    return int.from_bytes(hashlib.sha256(f"b/{i}".encode()).digest(), "big")


cases = [make_case(f"a{i}", b_from(i)) for i in range(4)]
want_b = want_s = True
for i in range(4, 20000):
    if not (want_b or want_s):
        break
    c = make_case(f"a{i}", b_from(i))
    if want_b and c["B_leading_zero"]:
        cases.append(c)
        want_b = False
    elif want_s and c["S_leading_zero"]:
        cases.append(c)
        want_s = False

json.dump({"user": SRP_USER, "password": BLE_PASSWORD, "cases": cases}, sys.stdout, indent=2)
print()

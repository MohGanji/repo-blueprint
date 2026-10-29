import httpx
from acme.util import helper


def run():
    return helper(httpx.get("https://example.com"))

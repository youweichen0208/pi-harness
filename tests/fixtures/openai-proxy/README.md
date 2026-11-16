This self-signed certificate and private key are public test fixtures, never production credentials. The proxy test trusts this certificate only in its isolated child process and routes the named hosts to its local TLS fixture. No external OpenAI requests are made.

`cert.pem` covers the three official OpenAI hosts. `relay-cert.pem` uses the same
public fixture key and additionally covers `custom.fixture`, `localhost` and
`127.0.0.1` for native transport routing and HTTPS upstream proxy tests. Both
certificates must be present in a clean checkout; the narrow `.gitignore`
exceptions include them without allowing arbitrary PEM credentials.

-- Separate database so pytest never touches dev data.
CREATE DATABASE worktrack_test;

-- Separate database for the web end-to-end test (it creates users that backend tests must not see).
CREATE DATABASE worktrack_e2e;

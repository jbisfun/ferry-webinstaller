libcurl_full.mjs: libcurl.js from github.com/jbisfun/libcurl.js, branch apple-roots
(b242bcc; upstream ading2210/libcurl.js master 2b6cff8, 0.7.5). The branch adds Apple
Root CA and Apple Root CA - G3 to curl's Mozilla bundle, because gsa.apple.com chains to
Apple's own root. Certificates are verified for every host.

Build (Linux, ~5 min):

    git clone -b apple-roots https://github.com/jbisfun/libcurl.js && cd libcurl.js
    git submodule update --init --depth 1          # wisp_client
    emsdk install 3.1.6 && emsdk activate 3.1.6 && source emsdk_env.sh
    pip install jinja2 jsonschema                  # mbedtls' generators
    cd client && ./build.sh release single_file
    cp out/libcurl_full.mjs <here>
    emsdk install latest && emsdk activate latest  # emsdk keeps one version on disk

Use Emscripten 3.1.6 (what its CI uses). Current Emscripten removed allocate and
isDataURI, which its JS glue needs; 3.1.72 builds but drops the Wisp target (the
relay URL override moved) and fails TLS with curl error 77.

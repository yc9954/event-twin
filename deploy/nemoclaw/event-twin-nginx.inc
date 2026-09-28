# Included only inside the existing Brev nginx server block.
# An unauthenticated request must still reach the app's gateway-key check.
location ^~ /event-twin-api/ {
    proxy_pass http://127.0.0.1:4188/api/;
    proxy_http_version 1.1;
    proxy_set_header Host 127.0.0.1:4188;
    proxy_set_header Origin "";
    proxy_set_header Sec-Fetch-Site "";
    proxy_set_header Cookie "";
    proxy_set_header X-Event-Twin-Proxy vercel;
    proxy_set_header X-Event-Twin-Key $http_x_event_twin_key;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 240s;
    proxy_send_timeout 240s;
    client_max_body_size 4m;
}

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY src /usr/share/nginx/html/src
COPY voice.js /usr/share/nginx/html/voice.js
EXPOSE 8080

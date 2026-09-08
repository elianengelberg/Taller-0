# Web de YCD (GitHub Pages)

Esta carpeta `docs/` es el sitio publicado con GitHub Pages: `index.html` (la web), `og.png` (vista previa para WhatsApp y redes) y `manual-ycd.pdf` (el manual de servicios enlazado desde la web).

Activar: Settings → Pages → Source "Deploy from a branch" → Branch `claude/twilio-regulatory-bundle-34zti1`, carpeta `/docs` → Save. Queda en https://elianengelberg.github.io/Taller-0/

Para conectar ycdoficial.com: en el mismo panel de Pages, "Custom domain" → ycdoficial.com, y en el DNS del dominio un registro CNAME de `www` a `elianengelberg.github.io` y los 4 registros A de GitHub para la raíz (185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153). Después, cambiar en `index.html` las tres URLs `https://elianengelberg.github.io/Taller-0/` por `https://ycdoficial.com/`.

La fuente y la versión editable viven en el vault `Agente-de-IA`, en `proyectos/emprendimiento/landing/`.

# BUG-42: finalPrice devuelve NaN

Varios clientes reportan importes `NaN` en el carrito.

Pasos observados en produccion:

1. Un producto con `taxCategory: 'exento'` se anade al carrito.
2. `Cart.total()` devuelve `NaN`.

Tambien ocurre con categorias mal escritas, por ejemplo `'Reducido'` o `'gneral'`.

Comportamiento requerido (aprobado por producto):

- La categoria `'exento'` debe existir y tener un impuesto del 0 %.
- Una categoria fiscal desconocida debe lanzar un `Error` cuyo mensaje contenga
  la palabra `categoria` y el nombre de la categoria recibida.
- Si no se indica categoria, se sigue usando `'general'`.
- Debe anadirse al menos un test automatizado que cubra el caso `'exento'`.

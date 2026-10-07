-- Frame swatches = the Figma colours the shop's frame picker already used.
UPDATE "product_option" SET swatch = CASE code WHEN 'oak' THEN '#6b3f0a' WHEN 'black' THEN '#111111' WHEN 'gold' THEN '#c48a3a' WHEN 'white' THEN '#d9d9d9' ELSE swatch END WHERE kind = 'FRAME';

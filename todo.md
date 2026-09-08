# TODO

## pos

## products
- implement converting mutliple products compacts into one product variants, eg. we may have two separate products with "oil filter / gmax / sakura" and "oil filter / hilux / sakura" and we want to compact them into one product instead "oil filter / sakura" with "gmax" and "hilux" variants
- product edit: stock adjust: set quantity as whole rather than using current quantity delta acting increase/decrease value, also fix cannot delete product when they have 0 stocks in two locations, one 0 stock location works fine.

## purchase orders
- price goes up indicator, that means we have to save the last variant cost to db

## stockeeper
- received indicator on the main PO list doesn't move, it stays 0 even after we checked all of the items. received bar works fine inside the PO checking thought.

# TODO

## pos

## products
- implement converting mutliple products compacts into one product variants, eg. we may have two separate products with "oil filter / gmax / sakura" and "oil filter / hilux / sakura" and we want to compact them into one product instead "oil filter / sakura" with "gmax" and "hilux" variants
- product edit: stock adjust: set quantity specificly rather than using current quantity delta, also fix cannot delete product when they have 0 stocks in two locations, one 0 stock location works fine.

## purchase orders
- price goes up indicator, that means we have to save the last variant cost to db
- should we remove the printing on purchase and requisition? since we only send rfq to vendor? or duplicates it sending feature so we dont have this redundant printing functions across purchasing menus?
- fix `unitCostMinor must be a non-negative integer` error after infield calculation result.

## deliveries
let's beautify and make ux easier.
- delivery list: current total cost includes the po line cost, it should only show the total cost line of the delivery, without
  including the po line cost.
- add ctrl+enter shortcut to submit forms
- line form: cost line: make description optional, auto focus on cost, and use ctrl+enter for submit shortcut and esc for canceling.
- line form: goods line: add goods lines: make the list compact, shows their total cost, add search field (or just use the existing purchase menu table filtering?). also in po line list, maybe we can add search bar as well? or use existing table view and filtering feature?

## rfq
- rfq detail screen: fix created always show invalid date
- i don't see any option or button to delete or cancel an rfq
- fix rfq selection not disappearing after deleting selections
- improve ux by moving add line item form onto the bottom of the section we want to add, maybe similar placement like in the
  requisition.

## stockeeper
- received indicator on the main PO list doesn't move, it stays 0 even after we checked all of the items. received bar works fine inside the PO checking thought.

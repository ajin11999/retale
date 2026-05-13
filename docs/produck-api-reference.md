# ProDuck API Reference

Source of truth for retale GraphQL schema parity. Original project: `C:\Users\Frans\ProDuck\`.

All original routes used AutoWrapper envelope: `{ code, message, result }` or `{ code, message, payload[], pagination }`.
In retale these map to GraphQL queries/mutations with typed return types.

---

## Auth

| Method | Route | Auth | Notes |
|--------|-------|------|-------|
| POST | `/Login` | None | username + password → JWT (HS512, 365 days) |
| GET | `/` | None | Welcome |
| POST | `/` | None | Bootstrap: create root user (only when users table empty) |
| GET | `/dashboard` | Authorized | ReplenishmentCount, ProductPriceCount, CustomerPriceCount |

---

## Users & Claims

| Method | Route | Auth | Notes |
|--------|-------|------|-------|
| GET | `/Users` | root | Paginated, filter by claimId/posId/keyword |
| GET | `/Users/{id}` | root | Single user |
| POST | `/Users` | root | Create user |
| PUT | `/Users/{id}` | root | Update user |
| DELETE | `/Users/{id}` | root | Delete user |
| POST | `/Users/assign/pos` | root | Assign user to POS |
| GET | `/Claims` | root | Paginated |
| POST | `/Claims` | root | Create claim |
| POST | `/Claims/assign` | root | Assign claim to user |
| PUT | `/Claims/{id}` | root | Update claim |
| DELETE | `/Claims/{id}` | root | Delete claim |

---

## Products & Categories

| Method | Route | Auth | Notes |
|--------|-------|------|-------|
| GET | `/Products` | Authorized | Paginated; filter by categoryId, excludeFromLocationId, emptyBarcode, keyword |
| GET | `/Products/all` | root/clerk | All products (unpaginated) |
| GET | `/Products/csv` | Authorized | CSV download |
| GET | `/Products/{id}` | Authorized | Single product |
| GET | `/Products/negativeprice` | Authorized | Products with negative sell price |
| GET | `/Products/negativecustomerprice` | Authorized | Products with negative customer price |
| POST | `/Products` | root | Create product |
| PUT | `/Products/{id}` | root | Update product |
| PUT | `/Products` | root | Bulk update (array); optional onlyBarcode flag |
| DELETE | `/Products/{id}` | root | Delete (soft delete in ProDuck; true delete in retale) |
| GET | `/Categories` | Authorized | Paginated; filter by exclude/parentId/showOnlyRootChilds/keyword |
| GET | `/Categories/replenishment` | Authorized | Categories needing replenishment |
| GET | `/Categories/{id}` | Authorized | Single category |
| POST | `/Categories` | root | Create category |
| PUT | `/Categories/{id}` | root | Update category |
| DELETE | `/Categories/{id}` | root | Delete category |

---

## Customers & Pricing

| Method | Route | Auth | Notes |
|--------|-------|------|-------|
| GET | `/Customers` | Authorized | Paginated, keyword |
| GET | `/Customers/{id}` | Authorized | Single customer |
| POST | `/Customers` | Authorized | Create customer |
| PUT | `/Customers/{id}` | root | Update customer |
| DELETE | `/Customers/{id}` | root | Delete (soft in ProDuck) |
| GET | `/CustomerPrices/products/{id}` | Authorized | Prices for a product, paginated |
| GET | `/CustomerPrices/customers/{id}` | Authorized | Prices for a customer, paginated |
| GET | `/CustomerPrices/customers/all/{id}` | Authorized | All prices for a customer (unpaginated) |
| POST | `/CustomerPrices` | root | Create customer price |
| PUT | `/CustomerPrices/{id}` | root | Update |
| DELETE | `/CustomerPrices/{id}` | root | Delete |

---

## Vendors & Purchases

| Method | Route | Auth | Notes |
|--------|-------|------|-------|
| GET | `/Vendors` | root | Paginated, keyword |
| GET | `/Vendors/{id}` | root | Single vendor |
| POST | `/Vendors` | root | Create |
| PUT | `/Vendors/{id}` | root | Update |
| DELETE | `/Vendors/{id}` | root | Delete (soft in ProDuck) |
| GET | `/Purchases` | root | Paginated; filter vendorId, showNotDelivered, keyword |
| GET | `/Purchases/{id}` | root | Single purchase |
| POST | `/Purchases` | root | Create |
| PUT | `/Purchases/{id}` | root | Update |
| DELETE | `/Purchases/{id}` | root | Delete |
| GET | `/PurchaseOrders/purchases/{id}` | root | PurchaseOrders for a purchase, paginated |
| POST | `/PurchaseOrders` | root | Create |
| PUT | `/PurchaseOrders/{id}` | root | Update |
| DELETE | `/PurchaseOrders/{id}` | root | Delete |

---

## Locations & Stock

| Method | Route | Auth | Notes |
|--------|-------|------|-------|
| GET | `/Locations` | Authorized | Paginated; filter exclude/parentId/productIdToExclude/showOnlyRootChilds/keyword |
| GET | `/Locations/{id}` | Authorized | Single location |
| POST | `/Locations` | root | Create |
| PUT | `/Locations/{id}` | root | Update |
| DELETE | `/Locations/{id}` | root | Delete (cascades children & stock) |
| GET | `/StockLocation/location/{id}` | Authorized | Products at a location; isRootLocation?, keyword |
| GET | `/StockLocation/product/{id}` | Authorized | Locations for a product |
| POST | `/StockLocation` | root | Create stock entry |
| PUT | `/StockLocation/{id}` | root | Update stock qty |
| DELETE | `/StockLocation/{id}` | root | Delete stock entry |

---

## Point of Sale

| Method | Route | Auth | Notes |
|--------|-------|------|-------|
| GET | `/POS` | Authorized | Paginated; filter userId, keyword |
| GET | `/POS/{id}` | Authorized | Single POS |
| POST | `/POS` | root | Create |
| PUT | `/POS/{id}` | root | Update |
| DELETE | `/POS/{id}` | root | Delete (soft in ProDuck) |
| GET | `/POSSessions` | Authorized | Paginated; filter posId |
| GET | `/POSSessions/{id}` | Authorized | Single session |
| POST | `/POSSessions` | root/clerk | Open session |
| PUT | `/POSSessions/close/{id}` | root/clerk | Close session |
| PUT | `/POSSessions/{id}` | root | Update session |

---

## Orders & Sales

| Method | Route | Auth | Notes |
|--------|-------|------|-------|
| GET | `/Orders` | Authorized | Paginated; filter userId, customerId, startDate, endDate |
| GET | `/Orders/{id}` | Authorized | Single order |
| GET | `/Orders/possessions/{id}` | Authorized | Orders by POS session |
| GET | `/Orders/poses/{id}` | Authorized | Orders by POS |
| POST | `/Orders` | root/clerk | Create order (auto-creates POSSession, calls StockService) |
| POST | `/Orders/return` | root/clerk | Return items → array of OrderDTOItem |
| GET | `/OrderItems/orders/{id}` | Authorized | Order items paginated |
| GET | `/OrderItems/orders/all/{id}` | Authorized | All order items (unpaginated) |
| GET | `/Sales` | root | Sales report; filter startDate, endDate → Sales[], TotalProfit |
| GET | `/Sales/session/{id}` | root | Sales for a session |

---

## Landed Costs

| Method | Route | Auth | Notes |
|--------|-------|------|-------|
| GET | `/LandedCosts` | root | Paginated; filter showNotDelivered, keyword |
| GET | `/LandedCosts/{id}` | root | Single |
| POST | `/LandedCosts` | root | Create → returns new ID |
| PUT | `/LandedCosts/{id}` | root | Update |
| POST | `/LandedCosts/deliver` | root | Deliver: complex stock/cost update logic |
| GET | `/LandedCostItems/landedcosts/{id}` | root | Items for a landed cost |
| POST | `/LandedCostItems/bulk` | root | Bulk create from purchase |
| POST | `/LandedCostItems/separated` | root | Create separated from purchase |
| POST | `/LandedCostItems` | root | Create single item |
| PUT | `/LandedCostItems/{id}` | root | Update |
| DELETE | `/LandedCostItems/{id}` | root | Delete |

---

## Data Types

| Type | Notes |
|------|-------|
| IDs | `bigint` (long in C#) |
| Prices/Costs | `decimal` |
| Quantities/Stock | `int` |
| Dates | `DateOnly` (date only, no time) |
| Timestamps | `DateTime` (CreatedAt, OpenedAt, ClosedAt, DeliveredAt) |

---

## Pagination Parameters

All paginated endpoints accept:
- `page` (int, default 1)
- `pageSize` (int, default 10, max 100)
- `keyword` (string, optional — split on whitespace, AND semantics)

---

## Known ProDuck Issues (Do Not Replicate)

- Cannot null a product's category via PUT
- DeliveryOrderController stubbed — skip entirely in retale
- CSV export used raw entity fields — in retale expose as proper query
- CORS was wide open — retale should configure properly for local network

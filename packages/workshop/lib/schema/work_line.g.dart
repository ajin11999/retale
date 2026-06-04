// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'work_line.dart';

// **************************************************************************
// IsarEmbeddedGenerator
// **************************************************************************

// coverage:ignore-file
// ignore_for_file: duplicate_ignore, non_constant_identifier_names, constant_identifier_names, invalid_use_of_protected_member, unnecessary_cast, prefer_const_constructors, lines_longer_than_80_chars, require_trailing_commas, inference_failure_on_function_invocation, unnecessary_parenthesis, unnecessary_raw_strings, unnecessary_null_checks, join_return_with_assignment, prefer_final_locals, avoid_js_rounded_ints, avoid_positional_boolean_parameters, always_specify_types

const WorkLineSchema = Schema(
  name: r'WorkLine',
  id: 7370500227191782151,
  properties: {
    r'children': PropertySchema(
      id: 0,
      name: r'children',
      type: IsarType.objectList,
      target: r'WorkLine',
    ),
    r'isGroup': PropertySchema(
      id: 1,
      name: r'isGroup',
      type: IsarType.bool,
    ),
    r'note': PropertySchema(
      id: 2,
      name: r'note',
      type: IsarType.string,
    ),
    r'qty': PropertySchema(
      id: 3,
      name: r'qty',
      type: IsarType.long,
    ),
    r'snapshotName': PropertySchema(
      id: 4,
      name: r'snapshotName',
      type: IsarType.string,
    ),
    r'unitPriceMinor': PropertySchema(
      id: 5,
      name: r'unitPriceMinor',
      type: IsarType.long,
    ),
    r'variantId': PropertySchema(
      id: 6,
      name: r'variantId',
      type: IsarType.string,
    ),
    r'variantKind': PropertySchema(
      id: 7,
      name: r'variantKind',
      type: IsarType.string,
    )
  },
  estimateSize: _workLineEstimateSize,
  serialize: _workLineSerialize,
  deserialize: _workLineDeserialize,
  deserializeProp: _workLineDeserializeProp,
);

int _workLineEstimateSize(
  WorkLine object,
  List<int> offsets,
  Map<Type, List<int>> allOffsets,
) {
  var bytesCount = offsets.last;
  {
    final list = object.children;
    if (list != null) {
      bytesCount += 3 + list.length * 3;
      {
        final offsets = allOffsets[WorkLine]!;
        for (var i = 0; i < list.length; i++) {
          final value = list[i];
          bytesCount += WorkLineSchema.estimateSize(value, offsets, allOffsets);
        }
      }
    }
  }
  bytesCount += 3 + object.note.length * 3;
  bytesCount += 3 + object.snapshotName.length * 3;
  {
    final value = object.variantId;
    if (value != null) {
      bytesCount += 3 + value.length * 3;
    }
  }
  {
    final value = object.variantKind;
    if (value != null) {
      bytesCount += 3 + value.length * 3;
    }
  }
  return bytesCount;
}

void _workLineSerialize(
  WorkLine object,
  IsarWriter writer,
  List<int> offsets,
  Map<Type, List<int>> allOffsets,
) {
  writer.writeObjectList<WorkLine>(
    offsets[0],
    allOffsets,
    WorkLineSchema.serialize,
    object.children,
  );
  writer.writeBool(offsets[1], object.isGroup);
  writer.writeString(offsets[2], object.note);
  writer.writeLong(offsets[3], object.qty);
  writer.writeString(offsets[4], object.snapshotName);
  writer.writeLong(offsets[5], object.unitPriceMinor);
  writer.writeString(offsets[6], object.variantId);
  writer.writeString(offsets[7], object.variantKind);
}

WorkLine _workLineDeserialize(
  Id id,
  IsarReader reader,
  List<int> offsets,
  Map<Type, List<int>> allOffsets,
) {
  final object = WorkLine();
  object.children = reader.readObjectList<WorkLine>(
    offsets[0],
    WorkLineSchema.deserialize,
    allOffsets,
    WorkLine(),
  );
  object.isGroup = reader.readBool(offsets[1]);
  object.note = reader.readString(offsets[2]);
  object.qty = reader.readLong(offsets[3]);
  object.snapshotName = reader.readString(offsets[4]);
  object.unitPriceMinor = reader.readLong(offsets[5]);
  object.variantId = reader.readStringOrNull(offsets[6]);
  object.variantKind = reader.readStringOrNull(offsets[7]);
  return object;
}

P _workLineDeserializeProp<P>(
  IsarReader reader,
  int propertyId,
  int offset,
  Map<Type, List<int>> allOffsets,
) {
  switch (propertyId) {
    case 0:
      return (reader.readObjectList<WorkLine>(
        offset,
        WorkLineSchema.deserialize,
        allOffsets,
        WorkLine(),
      )) as P;
    case 1:
      return (reader.readBool(offset)) as P;
    case 2:
      return (reader.readString(offset)) as P;
    case 3:
      return (reader.readLong(offset)) as P;
    case 4:
      return (reader.readString(offset)) as P;
    case 5:
      return (reader.readLong(offset)) as P;
    case 6:
      return (reader.readStringOrNull(offset)) as P;
    case 7:
      return (reader.readStringOrNull(offset)) as P;
    default:
      throw IsarError('Unknown property with id $propertyId');
  }
}

extension WorkLineQueryFilter
    on QueryBuilder<WorkLine, WorkLine, QFilterCondition> {
  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> childrenIsNull() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(const FilterCondition.isNull(
        property: r'children',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> childrenIsNotNull() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(const FilterCondition.isNotNull(
        property: r'children',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> childrenLengthEqualTo(
      int length) {
    return QueryBuilder.apply(this, (query) {
      return query.listLength(
        r'children',
        length,
        true,
        length,
        true,
      );
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> childrenIsEmpty() {
    return QueryBuilder.apply(this, (query) {
      return query.listLength(
        r'children',
        0,
        true,
        0,
        true,
      );
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> childrenIsNotEmpty() {
    return QueryBuilder.apply(this, (query) {
      return query.listLength(
        r'children',
        0,
        false,
        999999,
        true,
      );
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      childrenLengthLessThan(
    int length, {
    bool include = false,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.listLength(
        r'children',
        0,
        true,
        length,
        include,
      );
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      childrenLengthGreaterThan(
    int length, {
    bool include = false,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.listLength(
        r'children',
        length,
        include,
        999999,
        true,
      );
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> childrenLengthBetween(
    int lower,
    int upper, {
    bool includeLower = true,
    bool includeUpper = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.listLength(
        r'children',
        lower,
        includeLower,
        upper,
        includeUpper,
      );
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> isGroupEqualTo(
      bool value) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'isGroup',
        value: value,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> noteEqualTo(
    String value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'note',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> noteGreaterThan(
    String value, {
    bool include = false,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.greaterThan(
        include: include,
        property: r'note',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> noteLessThan(
    String value, {
    bool include = false,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.lessThan(
        include: include,
        property: r'note',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> noteBetween(
    String lower,
    String upper, {
    bool includeLower = true,
    bool includeUpper = true,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.between(
        property: r'note',
        lower: lower,
        includeLower: includeLower,
        upper: upper,
        includeUpper: includeUpper,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> noteStartsWith(
    String value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.startsWith(
        property: r'note',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> noteEndsWith(
    String value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.endsWith(
        property: r'note',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> noteContains(
      String value,
      {bool caseSensitive = true}) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.contains(
        property: r'note',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> noteMatches(
      String pattern,
      {bool caseSensitive = true}) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.matches(
        property: r'note',
        wildcard: pattern,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> noteIsEmpty() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'note',
        value: '',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> noteIsNotEmpty() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.greaterThan(
        property: r'note',
        value: '',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> qtyEqualTo(
      int value) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'qty',
        value: value,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> qtyGreaterThan(
    int value, {
    bool include = false,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.greaterThan(
        include: include,
        property: r'qty',
        value: value,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> qtyLessThan(
    int value, {
    bool include = false,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.lessThan(
        include: include,
        property: r'qty',
        value: value,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> qtyBetween(
    int lower,
    int upper, {
    bool includeLower = true,
    bool includeUpper = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.between(
        property: r'qty',
        lower: lower,
        includeLower: includeLower,
        upper: upper,
        includeUpper: includeUpper,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> snapshotNameEqualTo(
    String value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'snapshotName',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      snapshotNameGreaterThan(
    String value, {
    bool include = false,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.greaterThan(
        include: include,
        property: r'snapshotName',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> snapshotNameLessThan(
    String value, {
    bool include = false,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.lessThan(
        include: include,
        property: r'snapshotName',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> snapshotNameBetween(
    String lower,
    String upper, {
    bool includeLower = true,
    bool includeUpper = true,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.between(
        property: r'snapshotName',
        lower: lower,
        includeLower: includeLower,
        upper: upper,
        includeUpper: includeUpper,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      snapshotNameStartsWith(
    String value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.startsWith(
        property: r'snapshotName',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> snapshotNameEndsWith(
    String value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.endsWith(
        property: r'snapshotName',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> snapshotNameContains(
      String value,
      {bool caseSensitive = true}) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.contains(
        property: r'snapshotName',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> snapshotNameMatches(
      String pattern,
      {bool caseSensitive = true}) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.matches(
        property: r'snapshotName',
        wildcard: pattern,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      snapshotNameIsEmpty() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'snapshotName',
        value: '',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      snapshotNameIsNotEmpty() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.greaterThan(
        property: r'snapshotName',
        value: '',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> unitPriceMinorEqualTo(
      int value) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'unitPriceMinor',
        value: value,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      unitPriceMinorGreaterThan(
    int value, {
    bool include = false,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.greaterThan(
        include: include,
        property: r'unitPriceMinor',
        value: value,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      unitPriceMinorLessThan(
    int value, {
    bool include = false,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.lessThan(
        include: include,
        property: r'unitPriceMinor',
        value: value,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> unitPriceMinorBetween(
    int lower,
    int upper, {
    bool includeLower = true,
    bool includeUpper = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.between(
        property: r'unitPriceMinor',
        lower: lower,
        includeLower: includeLower,
        upper: upper,
        includeUpper: includeUpper,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdIsNull() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(const FilterCondition.isNull(
        property: r'variantId',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdIsNotNull() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(const FilterCondition.isNotNull(
        property: r'variantId',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdEqualTo(
    String? value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'variantId',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdGreaterThan(
    String? value, {
    bool include = false,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.greaterThan(
        include: include,
        property: r'variantId',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdLessThan(
    String? value, {
    bool include = false,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.lessThan(
        include: include,
        property: r'variantId',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdBetween(
    String? lower,
    String? upper, {
    bool includeLower = true,
    bool includeUpper = true,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.between(
        property: r'variantId',
        lower: lower,
        includeLower: includeLower,
        upper: upper,
        includeUpper: includeUpper,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdStartsWith(
    String value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.startsWith(
        property: r'variantId',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdEndsWith(
    String value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.endsWith(
        property: r'variantId',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdContains(
      String value,
      {bool caseSensitive = true}) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.contains(
        property: r'variantId',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdMatches(
      String pattern,
      {bool caseSensitive = true}) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.matches(
        property: r'variantId',
        wildcard: pattern,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantIdIsEmpty() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'variantId',
        value: '',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      variantIdIsNotEmpty() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.greaterThan(
        property: r'variantId',
        value: '',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantKindIsNull() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(const FilterCondition.isNull(
        property: r'variantKind',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      variantKindIsNotNull() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(const FilterCondition.isNotNull(
        property: r'variantKind',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantKindEqualTo(
    String? value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'variantKind',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      variantKindGreaterThan(
    String? value, {
    bool include = false,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.greaterThan(
        include: include,
        property: r'variantKind',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantKindLessThan(
    String? value, {
    bool include = false,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.lessThan(
        include: include,
        property: r'variantKind',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantKindBetween(
    String? lower,
    String? upper, {
    bool includeLower = true,
    bool includeUpper = true,
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.between(
        property: r'variantKind',
        lower: lower,
        includeLower: includeLower,
        upper: upper,
        includeUpper: includeUpper,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantKindStartsWith(
    String value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.startsWith(
        property: r'variantKind',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantKindEndsWith(
    String value, {
    bool caseSensitive = true,
  }) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.endsWith(
        property: r'variantKind',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantKindContains(
      String value,
      {bool caseSensitive = true}) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.contains(
        property: r'variantKind',
        value: value,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantKindMatches(
      String pattern,
      {bool caseSensitive = true}) {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.matches(
        property: r'variantKind',
        wildcard: pattern,
        caseSensitive: caseSensitive,
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> variantKindIsEmpty() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.equalTo(
        property: r'variantKind',
        value: '',
      ));
    });
  }

  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition>
      variantKindIsNotEmpty() {
    return QueryBuilder.apply(this, (query) {
      return query.addFilterCondition(FilterCondition.greaterThan(
        property: r'variantKind',
        value: '',
      ));
    });
  }
}

extension WorkLineQueryObject
    on QueryBuilder<WorkLine, WorkLine, QFilterCondition> {
  QueryBuilder<WorkLine, WorkLine, QAfterFilterCondition> childrenElement(
      FilterQuery<WorkLine> q) {
    return QueryBuilder.apply(this, (query) {
      return query.object(q, r'children');
    });
  }
}

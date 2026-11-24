# 3. list：最常用的顺序容器

```python
nums = [3, 1, 2]
nums.append(4)           # 尾部追加
nums.extend([5, 6])      # 追加多个
nums.insert(0, 0)        # 头部插入，O(n)
last = nums.pop()        # 弹出尾部，摊销 O(1)
first = nums.pop(0)      # 弹出头部，O(n)，数据量大时较慢

nums.sort()                         # 原地排序
ordered = sorted(nums, reverse=True)  # 返回降序的新列表

print(nums)
print(ordered)
```
